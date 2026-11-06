/**
 * Company administration for super admins: list, create, rename, disable.
 * Platform routes: no company context; company data is touched only through
 * runInCompany, one company at a time.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, rootDb, runInCompany } from '../db/client.js';
import { companies, employees, roles, users } from '../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { hashPassword } from '../lib/crypto.js';
import { writeAudit } from '../lib/audit.js';
import { invalidateAuthCache } from '../auth/session.js';
import { setupCompany } from '../services/companySetup.js';
import { getSetting, setSetting } from '../services/settings.js';

function requireSuperAdmin(req: FastifyRequest): void {
  if (!req.auth?.isSuperAdmin) throw new ForbiddenError('Only a super admin can manage companies');
}

const slugRe = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export async function platformRoutes(app: FastifyInstance): Promise<void> {
  const opts = { config: { platform: true } };

  app.get('/companies', opts, async (req) => {
    requireSuperAdmin(req);
    // owner connection: counts across companies, read in one grouped query each
    const list = await rootDb.select().from(companies).orderBy(asc(companies.name));
    const staff = await rootDb
      .select({
        companyId: employees.companyId,
        active: sql<number>`count(*) filter (where ${employees.status} = 'active')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(employees)
      .groupBy(employees.companyId);
    const accounts = await rootDb
      .select({ companyId: users.companyId, n: sql<number>`count(*)::int` })
      .from(users)
      .groupBy(users.companyId);
    return {
      data: list.map((c) => ({
        ...c,
        activeEmployees: staff.find((s) => s.companyId === c.id)?.active ?? 0,
        employees: staff.find((s) => s.companyId === c.id)?.total ?? 0,
        users: accounts.find((a) => a.companyId === c.id)?.n ?? 0,
      })),
    };
  });

  app.post('/companies', opts, async (req, reply) => {
    requireSuperAdmin(req);
    const body = z
      .object({
        name: z.string().trim().min(2).max(80),
        slug: z.string().trim().toLowerCase().regex(slugRe, 'Use 2–32 lowercase letters, digits or dashes'),
        admin: z.object({
          name: z.string().trim().min(1).max(120),
          email: z.string().email().transform((v) => v.toLowerCase().trim()),
          password: z.string().min(8, 'Use at least 8 characters'),
        }),
      })
      .parse(req.body);
    const [taken] = await rootDb.select({ id: companies.id }).from(companies).where(eq(companies.slug, body.slug));
    if (taken) throw new ConflictError(`The code "${body.slug}" is already used by another company`);

    const [company] = await rootDb.insert(companies).values({ name: body.name, slug: body.slug }).returning();
    try {
      await runInCompany(company.id, async (tx) => {
        await setupCompany(company.name);
        const [admin] = await db.select().from(roles).where(eq(roles.name, 'admin'));
        await db.insert(users).values({
          email: body.admin.email,
          name: body.admin.name,
          roleId: admin.id,
          passwordHash: await hashPassword(body.admin.password),
        });
        await writeAudit(tx, req, {
          action: 'create',
          entity: 'company',
          entityId: company.id,
          summary: `created the company ${company.name} with ${body.admin.email} as its HR admin`,
        });
      });
    } catch (err) {
      // setup failed: remove the empty company so the code can be reused
      await rootDb.delete(companies).where(eq(companies.id, company.id)).catch(() => undefined);
      throw err;
    }
    return reply.status(201).send(company);
  });

  app.patch('/companies/:id', opts, async (req) => {
    requireSuperAdmin(req);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({ name: z.string().trim().min(2).max(80).optional(), status: z.enum(['active', 'disabled']).optional() })
      .parse(req.body);
    const [before] = await rootDb.select().from(companies).where(eq(companies.id, id));
    if (!before) throw new NotFoundError('Company not found');
    if (body.status === 'disabled' && id === req.auth.homeCompanyId) {
      throw new ConflictError('You cannot disable your own company');
    }
    const [after] = await rootDb.update(companies).set(body).where(eq(companies.id, id)).returning();
    await runInCompany(id, async (tx) => {
      if (body.name && body.name !== before.name) {
        const s = await getSetting(tx, 'company');
        await setSetting(tx, 'company', { ...s, name: body.name }, req.auth.userId);
      }
      await writeAudit(tx, req, {
        action: 'update',
        entity: 'company',
        entityId: id,
        summary:
          body.status && body.status !== before.status
            ? `${body.status === 'disabled' ? 'disabled' : 're-enabled'} the company`
            : `renamed the company to ${after.name}`,
        before,
        after,
      });
    });
    invalidateAuthCache();
    return after;
  });
}
