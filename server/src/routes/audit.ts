import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { auditTrail, users } from '../db/schema.js';
import { requirePermission } from '../auth/plugin.js';
import { offsetOf, pageMeta, paginationSchema } from '../lib/pagination.js';
import { auditScope, redactAuditRow } from '../lib/auditAccess.js';

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: requirePermission('audit.view') }, async (req) => {
    const q = paginationSchema
      .extend({
        entity: z.string().optional(),
        entityId: z.string().optional(),
        action: z.string().optional(),
        userId: z.coerce.number().int().optional(),
        search: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .parse(req.query);
    const where = and(
      auditScope(req.auth),
      q.entity ? eq(auditTrail.entity, q.entity) : undefined,
      q.entityId ? eq(auditTrail.entityId, q.entityId) : undefined,
      q.action ? eq(auditTrail.action, q.action) : undefined,
      q.userId ? eq(auditTrail.userId, q.userId) : undefined,
      q.search ? or(ilike(auditTrail.summary, `%${q.search}%`), ilike(auditTrail.entityId, `%${q.search}%`)) : undefined,
      q.from ? gte(auditTrail.createdAt, new Date(`${q.from}T00:00:00Z`)) : undefined,
      q.to ? lte(auditTrail.createdAt, new Date(`${q.to}T23:59:59Z`)) : undefined,
    );
    const [{ total }] = await db.select({ total: count() }).from(auditTrail).where(where);
    const rows = await db
      .select({
        id: auditTrail.id,
        action: auditTrail.action,
        entity: auditTrail.entity,
        entityId: auditTrail.entityId,
        summary: auditTrail.summary,
        before: auditTrail.before,
        after: auditTrail.after,
        ip: auditTrail.ip,
        createdAt: auditTrail.createdAt,
        userId: auditTrail.userId,
        // a super admin from another company is not visible as a user row here
        userName: sql<string | null>`coalesce(${users.name}, case when ${auditTrail.userId} is not null then 'Super admin' end)`,
      })
      .from(auditTrail)
      .leftJoin(users, eq(auditTrail.userId, users.id))
      .where(where)
      .orderBy(desc(auditTrail.id))
      .limit(q.pageSize)
      .offset(offsetOf(q));
    return { data: rows.map((r) => redactAuditRow(r, req.auth)), meta: pageMeta(q, total) };
  });
}
