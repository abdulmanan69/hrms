import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { rootDb, runInCompany } from '../db/client.js';
import { companies, users } from '../db/schema.js';
import { authenticate, SESSION_COOKIE } from '../auth/plugin.js';
import { login, logout, revokeUserSessions, switchCompany } from '../auth/session.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { getSetting } from '../services/settings.js';

function secureCookie(req: FastifyRequest): boolean {
  return config.COOKIE_SECURE || req.protocol === 'https';
}

/** Sign-in, the current user, password and company switching. All platform routes. */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const platform = { platform: true };

  app.post('/login', { config: { ...platform, rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z
      .object({ email: z.string().email(), password: z.string().min(1), company: z.string().trim().toLowerCase().optional() })
      .parse(req.body);
    const result = await login(body.email, body.password, body.company, req.ip, req.headers['user-agent']);
    if (!result.ok && result.reason === 'choose_company') {
      return reply.status(409).send({ error: 'choose_company', message: 'This email has accounts in several companies. Pick one', companies: result.companies });
    }
    if (!result.ok) throw new UnauthorizedError('Email or password is incorrect');
    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie(req),
      path: '/',
      expires: result.expiresAt,
    });
    await runInCompany(result.auth.companyId, (tx) =>
      writeAudit(tx, { userId: result.auth.userId, ip: req.ip }, { action: 'login', entity: 'user', entityId: result.auth.userId }),
    );
    return { user: result.auth };
  });

  app.post('/logout', { config: platform }, async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /** The signed-in user, the company they work in, and the companies they may switch to. */
  app.get('/me', { preHandler: authenticate, config: platform }, async (req) => {
    const a = req.auth;
    const available = a.isSuperAdmin
      ? await rootDb
          .select({ id: companies.id, name: companies.name, slug: companies.slug, status: companies.status })
          .from(companies)
          .orderBy(asc(companies.name))
      : [{ id: a.companyId, name: a.companyName, slug: a.companySlug, status: 'active' as const }];
    const settings = await runInCompany(a.companyId, (tx) => getSetting(tx, 'company'));
    return {
      user: a,
      company: { id: a.companyId, name: a.companyName, slug: a.companySlug, currency: settings.currency },
      companies: available,
    };
  });

  /** Super admin: work in another company. The page reloads so nothing from the old one stays on screen. */
  app.post('/company', { preHandler: authenticate, config: platform }, async (req) => {
    const { companyId } = z.object({ companyId: z.number().int().positive() }).parse(req.body);
    const token = req.cookies?.[SESSION_COOKIE] ?? req.headers.authorization?.slice(7);
    if (!token) throw new UnauthorizedError();
    if (!(await switchCompany(token, req.auth, companyId))) throw new ForbiddenError('You cannot work in that company');
    await runInCompany(companyId, (tx) =>
      writeAudit(tx, req, { action: 'switch_company', entity: 'user', entityId: req.auth.userId, summary: `opened this company from ${req.auth.companyName}` }),
    );
    return { ok: true };
  });

  app.post('/password', { preHandler: authenticate, config: platform }, async (req) => {
    const body = z
      .object({ currentPassword: z.string().min(1), newPassword: z.string().min(8, 'Use at least 8 characters') })
      .parse(req.body);
    // the account lives in its home company, which may differ from the active one
    const [u] = await rootDb.select().from(users).where(and(eq(users.id, req.auth.userId), eq(users.companyId, req.auth.homeCompanyId)));
    if (!u || !(await verifyPassword(body.currentPassword, u.passwordHash))) {
      throw new ValidationError('Current password is incorrect');
    }
    await rootDb.update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, u.id));
    await revokeUserSessions(u.id);
    await runInCompany(u.companyId, (tx) =>
      writeAudit(tx, req, { action: 'change_password', entity: 'user', entityId: u.id, summary: 'changed their password' }),
    );
    return { ok: true, signedOut: true };
  });
}
