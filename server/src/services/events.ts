/**
 * Events for other systems, emitted from writeAudit: every audited state
 * change becomes one event in the outbox, inside the same transaction, so an
 * event exists exactly when its change was committed.
 *
 * Event type = '<entity>.<past-tense action>', e.g. employee.created,
 * leave_application.approved, payroll_run.paid, application.stage_changed.
 *
 * Payloads never carry CNIC, bank details, date of birth or secrets; a
 * consumer that needs more fetches the record by id with its own API key.
 */
import type { DbOrTx } from '../db/client.js';
import { employeeLinks, events, webhookDeliveries, webhooks } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const PAST: Record<string, string> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
  approve: 'approved',
  reject: 'rejected',
  cancel: 'cancelled',
  activate: 'activated',
  deactivate: 'deactivated',
  reactivate: 'reactivated',
  upload: 'uploaded',
  stage_change: 'stage_changed',
  hire: 'hired',
  pay: 'paid',
  mark_paid: 'paid',
  reopen: 'reopened',
  recompute: 'recomputed',
  submit: 'submitted',
  apply: 'submitted',
  adjust: 'adjusted',
  disable: 'disabled',
  revoke: 'revoked',
  received: 'received',
  void: 'voided',
  restore: 'restored',
};

/** Audit actions that are not business events. */
const SKIP = new Set(['login', 'change_password', 'reset_password', 'switch_company', 'export', 'view']);

/** Which module (permission) a reader needs for an entity's events. */
export const ENTITY_MODULE: Record<string, string> = {
  employee: 'employees.view',
  employee_document: 'employees.view',
  department: 'employees.view',
  designation: 'employees.view',
  candidate: 'recruitment.view',
  application: 'recruitment.view',
  interview: 'recruitment.view',
  communication: 'recruitment.view',
  payroll_run: 'payroll.view',
  payslip: 'payroll.view',
  salary_structure: 'payroll.view',
  loan: 'payroll.view',
  leave_application: 'leave.view',
  leave_ledger: 'leave.view',
  leave_type: 'leave.view',
  settings: 'settings.manage',
  user: 'users.manage',
  role: 'users.manage',
  company: 'users.manage',
  api_key: 'integrations.manage',
  employee_link: 'employees.view',
  employee_metric: 'employees.view',
  sale: 'sales.view',
  incentive_plan: 'sales.view',
  webhook: 'integrations.manage',
};

const NEVER_SENT = /^(cnic|bankName|accountNo|dateOfBirth|passwordHash|password|keyHash|secret|token|tokenHash|storedName|data)$/i;

/** A copy safe to hand to another system. */
function safe(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined || typeof v !== 'object' || depth > 3) return v ?? null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => safe(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (NEVER_SENT.test(k)) continue;
    out[k] = safe(val, depth + 1);
  }
  return out;
}

export function eventType(entity: string, action: string): string | null {
  if (SKIP.has(action)) return null;
  return `${entity}.${PAST[action] ?? action}`;
}

/** Does a subscription pattern ('*', 'employee.*', 'leave_application.approved') match a type? */
export function matches(pattern: string, type: string): boolean {
  if (pattern === '*' || pattern === type) return true;
  return pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1));
}

export interface EmitInput {
  entity: string;
  action: string;
  entityId: string | null;
  summary: string | null;
  after: unknown;
  actor: { userId: number | null; name?: string | null; apiKey?: string | null };
}

/** Writes the event and a pending delivery for every matching webhook. Same transaction as the change. */
export async function emitEvent(tx: DbOrTx, e: EmitInput): Promise<void> {
  const type = eventType(e.entity, e.action);
  if (!type) return;
  // events about a person carry that person's accounts in other systems, so a
  // receiver like VICIdial can act on its own agent without another lookup
  const after = (e.after ?? {}) as Record<string, unknown>;
  const sipId = e.entity === 'employee' ? e.entityId : typeof after.sipId === 'string' ? after.sipId : null;
  let links: Record<string, Array<{ externalId: string; context: string }>> | undefined;
  if (sipId) {
    const rows = await tx
      .select({ system: employeeLinks.system, externalId: employeeLinks.externalId, context: employeeLinks.context })
      .from(employeeLinks)
      .where(eq(employeeLinks.sipId, sipId));
    if (rows.length) {
      links = {};
      for (const r of rows) (links[r.system] ??= []).push({ externalId: r.externalId, context: r.context });
    }
  }
  const data = {
    entity: e.entity,
    id: e.entityId,
    sipId,
    summary: e.summary,
    actor: e.actor,
    record: safe(e.after),
    ...(links ? { links } : {}),
  };
  const [ev] = await tx
    .insert(events)
    .values({ type, entity: e.entity, entityId: e.entityId, module: ENTITY_MODULE[e.entity] ?? 'integrations.manage', data })
    .returning({ id: events.id, occurredAt: events.occurredAt, companyId: events.companyId });

  const hooks = await tx.select({ id: webhooks.id, events: webhooks.events }).from(webhooks).where(eq(webhooks.active, true));
  const due = hooks.filter((h) => h.events.some((p) => matches(p, type)));
  if (due.length === 0) return;
  const payload = { id: ev.id, type, occurredAt: ev.occurredAt.toISOString(), data };
  await tx.insert(webhookDeliveries).values(due.map((h) => ({ webhookId: h.id, eventId: ev.id, eventType: type, payload })));
}
