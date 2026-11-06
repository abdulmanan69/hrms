import type { FastifyRequest } from 'fastify';
import type { DbOrTx } from '../db/client.js';
import { auditTrail, notifications } from '../db/schema.js';
import { emitEvent } from '../services/events.js';

export interface AuditEntry {
  /** verb, e.g. 'create', 'update', 'stage_change', 'approve', 'deactivate' */
  action: string;
  /** table-ish name, e.g. 'employee', 'application', 'payroll_run', 'leave_application' */
  entity: string;
  entityId?: string | number | null;
  /** one readable line for activity feeds, e.g. "moved Zain Abbas to Offer made" */
  summary?: string;
  before?: unknown;
  after?: unknown;
}

type Actor = FastifyRequest | { userId: number | null; ip?: string | null };

function actorOf(a: Actor): { userId: number | null; ip: string | null } {
  if ('auth' in a) return { userId: a.auth?.userId ?? null, ip: a.ip ?? null };
  return { userId: a.userId, ip: a.ip ?? null };
}

/** Never store secrets in the trail. */
function clean(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (/password|token|hash/i.test(k)) continue;
    out[k] = val;
  }
  return out;
}

/** Every state change writes one row: who, when, what, before and after. */
export async function writeAudit(tx: DbOrTx, actor: Actor, e: AuditEntry): Promise<void> {
  const { userId, ip } = actorOf(actor);
  await tx.insert(auditTrail).values({
    userId,
    ip,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId == null ? null : String(e.entityId),
    // work done by another system reads e.g. 'approved … via API key "Payroll bridge"'
    summary: e.summary && 'auth' in actor && actor.auth?.apiKeyName ? `${e.summary} via API key "${actor.auth.apiKeyName}"` : (e.summary ?? null),
    before: clean(e.before),
    after: clean(e.after),
  });
  // the same change, as an event for other systems (webhooks, WebSocket, feed)
  await emitEvent(tx, {
    entity: e.entity,
    action: e.action,
    entityId: e.entityId == null ? null : String(e.entityId),
    summary: e.summary ?? null,
    after: e.after ?? null,
    actor: {
      userId,
      name: 'auth' in actor ? (actor.auth?.apiKeyName ? null : actor.auth?.name) ?? null : null,
      apiKey: 'auth' in actor ? actor.auth?.apiKeyName ?? null : null,
    },
  });
}

/** In-app notifications (the bell). Duplicate user ids are sent once. */
export async function notify(
  tx: DbOrTx,
  userIds: Array<number | null | undefined>,
  n: { title: string; body?: string; link?: string },
): Promise<void> {
  const ids = [...new Set(userIds.filter((x): x is number => typeof x === 'number'))];
  if (ids.length === 0) return;
  await tx.insert(notifications).values(ids.map((userId) => ({ userId, title: n.title, body: n.body ?? null, link: n.link ?? null })));
}
