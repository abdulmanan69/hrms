/**
 * API keys for other systems.
 *
 * Format: hrms_<prefix>_<secret>. The prefix (8 hex) finds the key; the whole
 * key is checked against its SHA-256. Only the hash is stored, so a lost key
 * can't be shown again, only replaced. A key acts in its own company with
 * exactly its scopes, and its actions are attributed to the person who
 * created it, marked "via API key …" in the audit trail.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { rootDb } from '../db/client.js';
import { apiKeys, companies, users } from '../db/schema.js';
import { sha256 } from '../lib/crypto.js';
import type { AuthContext } from '../auth/session.js';

export const KEY_RE = /^hrms_([0-9a-f]{8})_([0-9a-f]{40})$/;

export function generateKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(20).toString('hex');
  const key = `hrms_${prefix}_${secret}`;
  return { key, prefix, hash: sha256(key) };
}

const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; auth: AuthContext | null }>();
const lastTouched = new Map<number, number>();

export function invalidateApiKeyCache(): void {
  cache.clear();
}

/** Resolves a presented key to the context it acts with, or null. */
export async function resolveApiKey(token: string): Promise<AuthContext | null> {
  const m = KEY_RE.exec(token);
  if (!m) return null;
  const hash = sha256(token);
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.auth && { ...hit.auth };

  const [row] = await rootDb
    .select({ key: apiKeys, company: companies, creator: users })
    .from(apiKeys)
    .innerJoin(companies, eq(apiKeys.companyId, companies.id))
    .innerJoin(users, eq(apiKeys.createdBy, users.id))
    .where(and(eq(apiKeys.prefix, m[1]), isNull(apiKeys.revokedAt)));

  let auth: AuthContext | null = null;
  const a = Buffer.from(hash, 'hex');
  const b = row ? Buffer.from(row.key.keyHash, 'hex') : Buffer.alloc(32);
  const matches = !!row && a.length === b.length && timingSafeEqual(a, b);
  if (
    row &&
    matches &&
    (!row.key.expiresAt || row.key.expiresAt > new Date()) &&
    row.company.status === 'active' &&
    row.creator.status === 'active'
  ) {
    auth = {
      userId: row.creator.id,
      email: row.creator.email,
      name: `API key "${row.key.name}"`,
      companyId: row.company.id,
      companyName: row.company.name,
      companySlug: row.company.slug,
      homeCompanyId: row.company.id,
      isSuperAdmin: false,
      roleName: 'api_key',
      roleLabel: 'API key',
      permissions: row.key.scopes.filter((s) => s !== '*'),
      sipId: null,
      apiKeyId: row.key.id,
      apiKeyName: row.key.name,
    };
    // record use at most once a minute per key, outside any request transaction
    const now = Date.now();
    if ((lastTouched.get(row.key.id) ?? 0) < now - 60_000) {
      lastTouched.set(row.key.id, now);
      void rootDb.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.key.id)).catch(() => undefined);
    }
  }
  if (cache.size > 2000) cache.clear();
  cache.set(hash, { at: Date.now(), auth });
  return auth && { ...auth };
}
