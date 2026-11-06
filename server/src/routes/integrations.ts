/**
 * Integrations: API keys, webhooks, the event feed. Mounted at /api/v1/integrations.
 * Managing keys and webhooks needs integrations.manage; the event feed is open
 * to any caller and filtered by what the caller may see.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, rootDb } from '../db/client.js';
import { apiKeys, events, users, webhookDeliveries, webhooks } from '../db/schema.js';
import { can, requirePermission } from '../auth/plugin.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { offsetOf, pageMeta, paginationSchema } from '../lib/pagination.js';
import { generateKey, invalidateApiKeyCache } from '../services/apiKeys.js';
import { ENTITY_MODULE, matches } from '../services/events.js';
import { assertWebhookUrl, newWebhookSecret, sendOnce } from '../services/webhooks.js';
import { realtimeStats } from './realtime.js';

/** Event types other systems can subscribe to, for the UI picker and the docs. */
export const EVENT_CATALOG: Array<{ type: string; label: string }> = [
  { type: 'employee.created', label: 'Employee added (directly or by hiring)' },
  { type: 'employee.updated', label: 'Employee record changed' },
  { type: 'employee.activated', label: 'Employee activated' },
  { type: 'employee.deactivated', label: 'Employee deactivated' },
  { type: 'employee_document.uploaded', label: 'Document uploaded' },
  { type: 'candidate.created', label: 'Candidate added' },
  { type: 'application.stage_changed', label: 'Candidate moved stage or hired' },
  { type: 'application.rejected', label: 'Application rejected' },
  { type: 'interview.created', label: 'Interview scheduled' },
  { type: 'leave_application.created', label: 'Leave requested' },
  { type: 'leave_application.approved', label: 'Leave approved' },
  { type: 'leave_application.rejected', label: 'Leave rejected' },
  { type: 'leave_application.cancelled', label: 'Leave cancelled' },
  { type: 'payroll_run.created', label: 'Payroll run created' },
  { type: 'payroll_run.approved', label: 'Payroll run approved' },
  { type: 'payroll_run.paid', label: 'Payroll run marked paid' },
  { type: 'salary_structure.created', label: 'Salary set or increment added' },
];

const pattern = z.string().regex(/^(\*|[a-z_]+\.(\*|[a-z_]+))$/, 'Use "*", "entity.*" or "entity.action"');

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  const manage = { preHandler: requirePermission('integrations.manage') };

  /* ----------------------------- overview ----------------------------- */

  app.get('/overview', manage, async (req) => {
    const [{ keys }] = await db.select({ keys: count() }).from(apiKeys).where(isNull(apiKeys.revokedAt));
    const [{ hooks }] = await db.select({ hooks: count() }).from(webhooks).where(eq(webhooks.active, true));
    const [d] = await db
      .select({
        delivered: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'delivered' and ${webhookDeliveries.createdAt} > now() - interval '1 day')::int`,
        failed: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'failed' and ${webhookDeliveries.createdAt} > now() - interval '1 day')::int`,
        pending: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'pending')::int`,
      })
      .from(webhookDeliveries);
    const [last] = await db.select({ id: events.id }).from(events).orderBy(desc(events.id)).limit(1);
    return {
      activeKeys: keys,
      activeWebhooks: hooks,
      deliveriesToday: d,
      lastEventId: last?.id ?? 0,
      liveConnections: realtimeStats(req.auth.companyId).connections,
      scopes: PERMISSIONS,
      eventCatalog: EVENT_CATALOG,
    };
  });

  /* ------------------------------ API keys ----------------------------- */

  app.get('/keys', manage, async () => {
    const rows = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        scopes: apiKeys.scopes,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
        createdByName: users.name,
      })
      .from(apiKeys)
      .leftJoin(users, eq(apiKeys.createdBy, users.id))
      .orderBy(asc(apiKeys.revokedAt), desc(apiKeys.id));
    return { data: rows };
  });

  app.post('/keys', manage, async (req, reply) => {
    if (req.auth.apiKeyId) throw new ForbiddenError('An API key cannot create other keys');
    const body = z
      .object({
        name: z.string().trim().min(2).max(80),
        scopes: z.array(z.enum(PERMISSIONS)).min(1, 'Pick at least one permission'),
        expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
      })
      .parse(req.body);
    // a key never gets more than the person creating it holds
    const missing = body.scopes.filter((s) => !can(req.auth, s));
    if (missing.length) throw new ForbiddenError(`You don't hold: ${missing.join(', ')}`);
    const { key, prefix, hash } = generateKey();
    const [row] = await db
      .insert(apiKeys)
      .values({
        name: body.name,
        prefix,
        keyHash: hash,
        scopes: [...new Set(body.scopes)],
        createdBy: req.auth.userId,
        expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null,
      })
      .returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scopes: apiKeys.scopes, expiresAt: apiKeys.expiresAt });
    await writeAudit(db, req, {
      action: 'create',
      entity: 'api_key',
      entityId: row.id,
      summary: `created the API key "${row.name}" (${row.scopes.join(', ')})`,
      after: row,
    });
    reply.status(201);
    // the only time the full key is shown
    return { ...row, key };
  });

  /** Rename a key or change what it may do, without re-issuing it to the other system. */
  app.patch('/keys/:id', manage, async (req) => {
    if (req.auth.apiKeyId) throw new ForbiddenError('An API key cannot change keys');
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(2).max(80).optional(),
        scopes: z.array(z.enum(PERMISSIONS)).min(1, 'Pick at least one permission').optional(),
      })
      .parse(req.body);
    const missing = (body.scopes ?? []).filter((s) => !can(req.auth, s));
    if (missing.length) throw new ForbiddenError(`You don't hold: ${missing.join(', ')}`);
    const [before] = await db.select({ name: apiKeys.name, scopes: apiKeys.scopes }).from(apiKeys).where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)));
    if (!before) throw new NotFoundError('Key not found or revoked');
    const [row] = await db
      .update(apiKeys)
      .set({ ...(body.name ? { name: body.name } : {}), ...(body.scopes ? { scopes: [...new Set(body.scopes)] } : {}) })
      .where(eq(apiKeys.id, id))
      .returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scopes: apiKeys.scopes, expiresAt: apiKeys.expiresAt });
    invalidateApiKeyCache();
    await writeAudit(db, req, {
      action: 'update',
      entity: 'api_key',
      entityId: id,
      summary: `changed the API key "${row.name}" (${row.scopes.join(', ')})`,
      before,
      after: { name: row.name, scopes: row.scopes },
    });
    return row;
  });

  app.post('/keys/:id/revoke', manage, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const [row] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id, name: apiKeys.name });
    if (!row) throw new NotFoundError('Key not found or already revoked');
    invalidateApiKeyCache();
    await writeAudit(db, req, { action: 'revoke', entity: 'api_key', entityId: id, summary: `revoked the API key "${row.name}"` });
    return { ok: true };
  });

  /* ------------------------------ webhooks ----------------------------- */

  const hookCols = {
    id: webhooks.id,
    name: webhooks.name,
    url: webhooks.url,
    events: webhooks.events,
    active: webhooks.active,
    createdAt: webhooks.createdAt,
  };

  app.get('/webhooks', manage, async () => {
    const rows = await db.select(hookCols).from(webhooks).orderBy(desc(webhooks.id));
    const stats = rows.length
      ? await db
          .select({
            webhookId: webhookDeliveries.webhookId,
            delivered: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'delivered')::int`,
            failed: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'failed')::int`,
            pending: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'pending')::int`,
            lastAt: sql<string | null>`max(${webhookDeliveries.createdAt})`,
          })
          .from(webhookDeliveries)
          .where(inArray(webhookDeliveries.webhookId, rows.map((r) => r.id)))
          .groupBy(webhookDeliveries.webhookId)
      : [];
    return { data: rows.map((r) => ({ ...r, stats: stats.find((s) => s.webhookId === r.id) ?? { delivered: 0, failed: 0, pending: 0, lastAt: null } })) };
  });

  const hookBody = z.object({
    name: z.string().trim().min(2).max(80),
    url: z.string().trim().max(500),
    events: z.array(pattern).min(1, 'Pick at least one event').max(50),
    active: z.boolean().optional(),
  });

  app.post('/webhooks', manage, async (req, reply) => {
    const body = hookBody.parse(req.body);
    await assertWebhookUrl(body.url);
    const secret = newWebhookSecret();
    const [row] = await db
      .insert(webhooks)
      .values({ name: body.name, url: body.url, events: [...new Set(body.events)], secret, active: body.active ?? true, createdBy: req.auth.userId })
      .returning(hookCols);
    await writeAudit(db, req, { action: 'create', entity: 'webhook', entityId: row.id, summary: `added the webhook "${row.name}" to ${new URL(row.url).host}`, after: row });
    reply.status(201);
    // the signing secret is shown this once
    return { ...row, secret };
  });

  app.patch('/webhooks/:id', manage, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = hookBody.partial().parse(req.body);
    if (body.url) await assertWebhookUrl(body.url);
    const [before] = await db.select(hookCols).from(webhooks).where(eq(webhooks.id, id));
    if (!before) throw new NotFoundError('Webhook not found');
    const [after] = await db
      .update(webhooks)
      .set({ ...body, ...(body.events ? { events: [...new Set(body.events)] } : {}) })
      .where(eq(webhooks.id, id))
      .returning(hookCols);
    await writeAudit(db, req, { action: 'update', entity: 'webhook', entityId: id, summary: `changed the webhook "${after.name}"`, before, after });
    return after;
  });

  app.post('/webhooks/:id/rotate-secret', manage, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const secret = newWebhookSecret();
    const [row] = await db.update(webhooks).set({ secret }).where(eq(webhooks.id, id)).returning({ name: webhooks.name });
    if (!row) throw new NotFoundError('Webhook not found');
    await writeAudit(db, req, { action: 'update', entity: 'webhook', entityId: id, summary: `issued a new signing secret for the webhook "${row.name}"` });
    return { secret };
  });

  app.delete('/webhooks/:id', manage, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const [row] = await db.delete(webhooks).where(eq(webhooks.id, id)).returning({ name: webhooks.name });
    if (!row) throw new NotFoundError('Webhook not found');
    await writeAudit(db, req, { action: 'delete', entity: 'webhook', entityId: id, summary: `removed the webhook "${row.name}"` });
    return { ok: true };
  });

  /** Sends a signed test event right now and reports what the receiver answered. */
  app.post('/webhooks/:id/test', manage, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const [exists] = await db.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.id, id));
    if (!exists) throw new NotFoundError('Webhook not found');
    // the secret is not readable from a request; the owner connection reads it for this one send
    const [hook] = await rootDb.select({ url: webhooks.url, secret: webhooks.secret }).from(webhooks).where(eq(webhooks.id, id));
    const payload = {
      id: 0,
      type: 'webhook.test',
      occurredAt: new Date().toISOString(),
      data: { summary: `Test from ${req.auth.companyName} HRMS`, actor: { name: req.auth.name } },
    };
    return sendOnce(hook, { id: 0, eventType: 'webhook.test', payload });
  });

  app.get('/webhooks/:id/deliveries', manage, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const q = paginationSchema.extend({ status: z.enum(['pending', 'delivered', 'failed']).optional() }).parse(req.query);
    const where = and(eq(webhookDeliveries.webhookId, id), q.status ? eq(webhookDeliveries.status, q.status) : undefined);
    const [{ total }] = await db.select({ total: count() }).from(webhookDeliveries).where(where);
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(where)
      .orderBy(desc(webhookDeliveries.id))
      .limit(q.pageSize)
      .offset(offsetOf(q));
    return { data: rows, meta: pageMeta(q, total) };
  });

  app.post('/deliveries/:id/redeliver', manage, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const [row] = await db
      .update(webhookDeliveries)
      .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), error: null })
      .where(eq(webhookDeliveries.id, id))
      .returning({ id: webhookDeliveries.id });
    if (!row) throw new NotFoundError('Delivery not found');
    return { ok: true };
  });

  /* -------------------------------- events ------------------------------ */

  /**
   * The polling feed: events after a cursor, oldest first, limited to modules
   * the caller may open. Call again with ?after=<last id> to continue.
   */
  app.get('/events', async (req) => {
    const q = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        types: z.string().optional(),
      })
      .parse(req.query);
    const patterns = q.types ? q.types.split(',').map((t) => pattern.parse(t.trim())) : ['*'];
    const visible = [...new Set(Object.values(ENTITY_MODULE))].filter((m) => can(req.auth, m as (typeof PERMISSIONS)[number]));
    if (visible.length === 0) return { data: [], next: q.after };
    const rows = await db
      .select({ id: events.id, type: events.type, occurredAt: events.occurredAt, data: events.data })
      .from(events)
      .where(and(gt(events.id, q.after), inArray(events.module, visible)))
      .orderBy(asc(events.id))
      .limit(q.limit);
    const data = rows.filter((r) => patterns.some((p) => matches(p, r.type)));
    return { data, next: rows.length ? rows[rows.length - 1].id : q.after };
  });

  app.get('/events/catalog', async () => ({ data: EVENT_CATALOG }));

}
