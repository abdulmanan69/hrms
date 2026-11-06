/**
 * Sign-in and sessions. These run before a company is known, so they use the
 * unrestricted rootDb and always filter by token, email or id themselves.
 */
import { and, eq, gt } from 'drizzle-orm';
import { currentCompanyId, db, rootDb } from '../db/client.js';
import { companies, roles, sessions, users } from '../db/schema.js';
import { config } from '../config.js';
import { newSessionToken, sha256, verifyPassword } from '../lib/crypto.js';

export interface AuthContext {
  userId: number;
  email: string;
  name: string;
  /** the company this session works in; every query is limited to it */
  companyId: number;
  companyName: string;
  companySlug: string;
  /** the account's own company (differs while a super admin works elsewhere) */
  homeCompanyId: number;
  isSuperAdmin: boolean;
  roleName: string;
  roleLabel: string;
  permissions: string[];
  /** linked employee record in the active company, null otherwise */
  sipId: string | null;
  /** set when the caller is another system using an API key */
  apiKeyId?: number;
  apiKeyName?: string;
}

type Row = {
  user: typeof users.$inferSelect;
  role: typeof roles.$inferSelect;
  home: typeof companies.$inferSelect;
};

/** Access in `active`: the account's own role at home, full access elsewhere for a super admin. */
function toAuth({ user, role, home }: Row, active: typeof companies.$inferSelect): AuthContext {
  const atHome = active.id === user.companyId;
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    companyId: active.id,
    companyName: active.name,
    companySlug: active.slug,
    homeCompanyId: home.id,
    isSuperAdmin: user.isSuperAdmin,
    roleName: atHome ? role.name : 'super_admin',
    roleLabel: atHome ? role.label : 'Super admin',
    permissions: atHome ? role.permissions : ['*'],
    sipId: atHome ? user.sipId : null,
  };
}

async function accountsByEmail(email: string): Promise<Row[]> {
  return rootDb
    .select({ user: users, role: roles, home: companies })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .innerJoin(companies, eq(users.companyId, companies.id))
    .where(eq(users.email, email.toLowerCase().trim()));
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; auth: AuthContext }
  | { ok: false; reason: 'invalid' }
  /** the password matched accounts in several companies: ask which one */
  | { ok: false; reason: 'choose_company'; companies: Array<{ slug: string; name: string }> };

export async function login(
  email: string,
  password: string,
  companySlug: string | undefined,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<LoginResult> {
  const candidates = (await accountsByEmail(email)).filter(
    (r) => r.user.status === 'active' && (r.home.status === 'active' || r.user.isSuperAdmin),
  );
  // check the password against every account with this email; a company is
  // only revealed to someone who already knows that account's password
  const matches: Row[] = [];
  for (const r of candidates) if (await verifyPassword(password, r.user.passwordHash)) matches.push(r);
  if (matches.length === 0) return { ok: false, reason: 'invalid' };

  let chosen: Row | undefined;
  if (matches.length === 1) chosen = matches[0];
  else if (companySlug) chosen = matches.find((m) => m.home.slug === companySlug);
  if (!chosen) {
    return {
      ok: false,
      reason: 'choose_company',
      companies: matches.map((m) => ({ slug: m.home.slug, name: m.home.name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  const { token, tokenHash } = newSessionToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600 * 1000);
  await rootDb.insert(sessions).values({
    userId: chosen.user.id,
    companyId: chosen.home.id,
    tokenHash,
    expiresAt,
    ip: ip ?? null,
    userAgent: userAgent?.slice(0, 500) ?? null,
  });
  await rootDb.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, chosen.user.id));
  return { ok: true, token, expiresAt, auth: toAuth(chosen, chosen.home) };
}

/**
 * Session lookups are cached a few seconds; any successful write through the
 * API clears the cache (app.ts), so role, status and company changes apply on
 * the next request. Bounded size: cleared when it reaches the cap.
 */
const CACHE_MS = 10_000;
const CACHE_MAX = 5_000;
const cache = new Map<string, { at: number; expiresAt: number; auth: AuthContext }>();
/** bumped on every invalidation: a lookup that started before it never writes its (possibly stale) result */
let generation = 0;

export function invalidateAuthCache(): void {
  generation++;
  cache.clear();
}

export async function resolveSession(token: string): Promise<AuthContext | null> {
  const tokenHash = sha256(token);
  const now = Date.now();
  const hit = cache.get(tokenHash);
  if (hit && now - hit.at < CACHE_MS && hit.expiresAt > now) return { ...hit.auth };

  const startedAt = generation;
  const [row] = await rootDb
    .select({ user: users, role: roles, home: companies, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(roles, eq(users.roleId, roles.id))
    .innerJoin(companies, eq(users.companyId, companies.id))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())));
  if (!row || row.user.status !== 'active') {
    cache.delete(tokenHash);
    return null;
  }

  let active = row.home;
  if (row.session.companyId !== row.user.companyId) {
    // only a super admin may work outside their own company
    if (!row.user.isSuperAdmin) return null;
    const [c] = await rootDb.select().from(companies).where(eq(companies.id, row.session.companyId));
    if (!c) return null;
    active = c;
  }
  // a disabled company locks out its own people; super admins can still get in to re-enable it
  if (active.status !== 'active' && !row.user.isSuperAdmin) return null;

  const auth = toAuth(row, active);
  if (startedAt !== generation) return { ...auth };
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(tokenHash, { at: now, expiresAt: row.session.expiresAt.getTime(), auth });
  return { ...auth };
}

/** Super admin: move this session into another company (or back home). */
export async function switchCompany(token: string, auth: AuthContext, companyId: number): Promise<boolean> {
  if (!auth.isSuperAdmin && companyId !== auth.homeCompanyId) return false;
  const [c] = await rootDb.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
  if (!c) return false;
  const tokenHash = sha256(token);
  await rootDb.update(sessions).set({ companyId }).where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.userId, auth.userId)));
  invalidateAuthCache();
  return true;
}

export async function logout(token: string): Promise<void> {
  const tokenHash = sha256(token);
  cache.delete(tokenHash);
  await rootDb.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/**
 * Signs a user out everywhere. Inside a request it reuses the request's own
 * connection (never a second one, so a busy pool can't deadlock).
 */
export async function revokeUserSessions(userId: number): Promise<void> {
  invalidateAuthCache();
  await (currentCompanyId() ? db : rootDb).delete(sessions).where(eq(sessions.userId, userId));
}
