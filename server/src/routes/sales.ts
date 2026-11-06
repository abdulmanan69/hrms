/**
 * Sales and sales incentives. Mounted at /api/v1/sales.
 *
 *   GET  /sales/summary?month=          per person: sales by role and the incentive earned
 *   GET  /sales?month=&sipId=…          the sales themselves
 *   POST /sales                         record a sale by hand (closer, optional fronter)
 *   POST /sales/:id/void | /restore     take a sale out of the count, or put it back
 *   GET  /sales/plan, PUT /sales/plan   incentive slabs per role
 *   GET  /sales/people/:sipId?month=    one person's month (profile, self-service)
 *
 * Systems such as VICIdial report sales through /connect/:system/sales.
 * Sales of a month whose payroll is approved or paid no longer change.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { departments, designations, employees, sales } from '../db/schema.js';
import { assertCanReadEmployee, can, requirePermission } from '../auth/plugin.js';
import type { AuthContext } from '../auth/session.js';
import { writeAudit } from '../lib/audit.js';
import { isISODate, isMonth, monthBounds, monthOf, todayISO } from '../lib/dates.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { offsetOf, pageMeta, paginationSchema } from '../lib/pagination.js';
import { employeeNameSql } from '../services/people.js';
import { closedMonths, incentiveOf, salesCounts } from '../services/sales.js';
import { getSetting, setSetting, type IncentiveSettings } from '../services/settings.js';
import { monthLabel, pkr } from '../services/payrollService.js';

const month = z.string().refine(isMonth, 'Month is YYYY-MM');
const isoDate = z.string().refine(isISODate, 'Date is YYYY-MM-DD');
const role = z.enum(['closer', 'fronter']);
const idParam = z.object({ id: z.coerce.number().int().positive() });

const planSchema = z.object({
  mode: z.enum(['reached', 'stepped']),
  slabs: z
    .array(z.object({ from: z.number().int().min(1).max(100_000), rate: z.number().int().min(0).max(10_000_000) }))
    .max(20)
    .refine((s) => new Set(s.map((x) => x.from)).size === s.length, 'Two slabs start at the same number of sales'),
});
const incentiveSchema = z.object({ closer: planSchema, fronter: planSchema, includeInPayroll: z.boolean() });

/** Which sales rows the caller may see: all, their team and themselves, or nothing. */
function scope(auth: AuthContext): SQL | undefined {
  if (can(auth, 'sales.view')) return undefined;
  if (can(auth, 'team.view') && auth.sipId) return or(eq(employees.managerSipId, auth.sipId), eq(sales.sipId, auth.sipId));
  throw new ForbiddenError('Missing permission: sales.view or team.view');
}

async function assertOpen(saleDate: string) {
  const m = monthOf(saleDate);
  if ((await closedMonths(db)).has(m)) {
    throw new ConflictError(`${monthLabel(m)} payroll is approved, so its sales are final. Reopen the payroll run to change them`);
  }
}

const rowSelect = {
  id: sales.id,
  sipId: sales.sipId,
  name: employeeNameSql,
  department: departments.name,
  role: sales.role,
  saleDate: sales.saleDate,
  source: sales.source,
  context: sales.context,
  externalRef: sales.externalRef,
  externalUser: sales.externalUser,
  reference: sales.reference,
  amount: sales.amount,
  note: sales.note,
  status: sales.status,
  voidReason: sales.voidReason,
  createdAt: sales.createdAt,
};

export async function salesRoutes(app: FastifyInstance): Promise<void> {
  const manage = { preHandler: requirePermission('sales.manage') };

  /** Per person for one month, with the incentive each has earned so far. */
  app.get('/summary', async (req) => {
    const q = z.object({ month: month.default(todayISO().slice(0, 7)) }).parse(req.query);
    const where = scope(req.auth);
    const { start, end } = monthBounds(q.month);
    const inMonth = and(eq(sales.status, 'confirmed'), gte(sales.saleDate, start), lte(sales.saleDate, end), where);

    const perPerson = await db
      .select({
        sipId: sales.sipId,
        name: employeeNameSql,
        department: departments.name,
        designation: designations.title,
        closer: sql<number>`count(*) filter (where ${sales.role} = 'closer')::int`,
        fronter: sql<number>`count(*) filter (where ${sales.role} = 'fronter')::int`,
        value: sql<number>`coalesce(sum(${sales.amount}) filter (where ${sales.role} = 'closer'), 0)::int`,
      })
      .from(sales)
      .innerJoin(employees, eq(sales.sipId, employees.sipId))
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .leftJoin(designations, eq(employees.designationId, designations.id))
      .where(inMonth)
      .groupBy(sales.sipId, employees.firstName, employees.middleInitial, employees.lastName, departments.name, designations.title);

    const byDay = await db
      .select({
        date: sales.saleDate,
        closer: sql<number>`count(*) filter (where ${sales.role} = 'closer')::int`,
        fronter: sql<number>`count(*) filter (where ${sales.role} = 'fronter')::int`,
      })
      .from(sales)
      .innerJoin(employees, eq(sales.sipId, employees.sipId))
      .where(inMonth)
      .groupBy(sales.saleDate)
      .orderBy(asc(sales.saleDate));

    const [voided] = await db
      .select({ n: count() })
      .from(sales)
      .innerJoin(employees, eq(sales.sipId, employees.sipId))
      .where(and(eq(sales.status, 'void'), gte(sales.saleDate, start), lte(sales.saleDate, end), where));

    const plan = await getSetting(db, 'incentives');
    const people = perPerson
      .map((p) => {
        const inc = incentiveOf({ closer: p.closer, fronter: p.fronter }, plan);
        return {
          ...p,
          closerIncentive: inc.closer.amount,
          fronterIncentive: inc.fronter.amount,
          incentive: inc.total,
          closerToNext: inc.closer.toNext,
          fronterToNext: inc.fronter.toNext,
        };
      })
      .sort((a, b) => b.closer - a.closer || b.fronter - a.fronter || a.name.localeCompare(b.name));

    return {
      month: q.month,
      closed: (await closedMonths(db)).has(q.month),
      plan,
      totals: {
        closer: people.reduce((n, p) => n + p.closer, 0),
        fronter: people.reduce((n, p) => n + p.fronter, 0),
        incentive: people.reduce((n, p) => n + p.incentive, 0),
        value: people.reduce((n, p) => n + p.value, 0),
        people: people.length,
        voided: voided.n,
      },
      byDay,
      people,
    };
  });

  app.get('/', async (req) => {
    const q = paginationSchema
      .extend({
        month: month.optional(),
        sipId: z.string().trim().optional(),
        role: role.optional(),
        status: z.enum(['confirmed', 'void']).optional(),
        source: z.string().trim().max(32).optional(),
        search: z.string().trim().max(100).optional(),
      })
      .parse(req.query);
    const bounds = q.month ? monthBounds(q.month) : null;
    const like = q.search ? `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where = and(
      scope(req.auth),
      bounds ? and(gte(sales.saleDate, bounds.start), lte(sales.saleDate, bounds.end)) : undefined,
      q.sipId ? eq(sales.sipId, q.sipId) : undefined,
      q.role ? eq(sales.role, q.role) : undefined,
      q.status ? eq(sales.status, q.status) : undefined,
      q.source ? eq(sales.source, q.source) : undefined,
      like ? or(ilike(sales.reference, like), ilike(sales.externalUser, like), ilike(employeeNameSql, like), ilike(sales.sipId, like)) : undefined,
    );
    const [{ n }] = await db.select({ n: count() }).from(sales).innerJoin(employees, eq(sales.sipId, employees.sipId)).where(where);
    const data = await db
      .select(rowSelect)
      .from(sales)
      .innerJoin(employees, eq(sales.sipId, employees.sipId))
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .where(where)
      .orderBy(desc(sales.saleDate), desc(sales.id))
      .limit(q.pageSize)
      .offset(offsetOf(q));
    return { data, meta: pageMeta(q, n) };
  });

  /** A sale entered by hand: one row for the closer, and one for the fronter when given. */
  app.post('/', manage, async (req, reply) => {
    const body = z
      .object({
        sipId: z.string().trim().min(1),
        fronterSipId: z.string().trim().min(1).optional().nullable(),
        saleDate: isoDate,
        reference: z.string().trim().max(120).optional().nullable(),
        amount: z.number().int().min(0).max(1_000_000_000).optional().nullable(),
        note: z.string().trim().max(500).optional().nullable(),
      })
      .parse(req.body);
    if (body.saleDate > todayISO()) throw new ValidationError('The sale date is in the future');
    if (body.fronterSipId && body.fronterSipId === body.sipId) throw new ValidationError('The closer and the fronter are the same person');
    await assertOpen(body.saleDate);
    const sips = [body.sipId, ...(body.fronterSipId ? [body.fronterSipId] : [])];
    const found = await db.select({ sipId: employees.sipId, name: employeeNameSql }).from(employees).where(inArray(employees.sipId, sips));
    for (const s of sips) if (!found.some((f) => f.sipId === s)) throw new ValidationError(`No employee with SIP ID ${s}`);
    const nameOf = (s: string) => found.find((f) => f.sipId === s)!.name;

    const rows = await db
      .insert(sales)
      .values(
        sips.map((sipId, i) => ({
          sipId,
          role: i === 0 ? 'closer' : 'fronter',
          saleDate: body.saleDate,
          source: 'manual',
          reference: body.reference || null,
          amount: i === 0 ? (body.amount ?? null) : null,
          note: body.note || null,
          createdBy: req.auth.userId,
        })),
      )
      .returning();
    await writeAudit(db, req, {
      action: 'create',
      entity: 'sale',
      entityId: rows[0].id,
      summary: `recorded a sale for ${nameOf(body.sipId)}${body.fronterSipId ? `, fronted by ${nameOf(body.fronterSipId)}` : ''}${body.reference ? ` (${body.reference})` : ''}`,
      after: { sipId: body.sipId, fronterSipId: body.fronterSipId ?? null, saleDate: body.saleDate, reference: body.reference ?? null, amount: body.amount ?? null },
    });
    return reply.status(201).send({ data: rows });
  });

  async function setStatus(req: FastifyRequest, status: 'void' | 'confirmed') {
    const { id } = idParam.parse(req.params);
    const body = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    const [row] = await db.select({ s: sales, name: employeeNameSql }).from(sales).innerJoin(employees, eq(sales.sipId, employees.sipId)).where(eq(sales.id, id));
    if (!row) throw new NotFoundError('Sale not found');
    if (row.s.status === status) return { data: row.s };
    if (status === 'void' && !body.reason) throw new ValidationError('Say why the sale is voided');
    await assertOpen(row.s.saleDate);
    const [after] = await db
      .update(sales)
      .set(
        status === 'void'
          ? { status, voidReason: body.reason!, voidedBy: req.auth.userId, updatedAt: new Date() }
          : { status, voidReason: null, voidedBy: null, updatedAt: new Date() },
      )
      .where(eq(sales.id, id))
      .returning();
    await writeAudit(db, req, {
      action: status === 'void' ? 'void' : 'restore',
      entity: 'sale',
      entityId: id,
      summary: `${status === 'void' ? 'voided' : 'restored'} a ${row.s.role === 'closer' ? 'sale' : 'fronter credit'} of ${row.name} on ${row.s.saleDate}${status === 'void' ? `: ${body.reason}` : ''}`,
      before: { status: row.s.status },
      after: { status, sipId: row.s.sipId, voidReason: after.voidReason },
    });
    return { data: after };
  }

  app.post('/:id/void', manage, (req) => setStatus(req, 'void'));
  app.post('/:id/restore', manage, (req) => setStatus(req, 'confirmed'));

  app.get('/plan', async (req) => {
    if (!can(req.auth, 'sales.view') && !can(req.auth, 'sales.manage') && !can(req.auth, 'team.view') && !req.auth.sipId) {
      throw new ForbiddenError('Missing permission: sales.view');
    }
    return getSetting(db, 'incentives');
  });

  app.put('/plan', manage, async (req) => {
    const body = incentiveSchema.parse(req.body) as IncentiveSettings;
    for (const r of ['closer', 'fronter'] as const) body[r].slabs.sort((a, b) => a.from - b.from);
    const before = await getSetting(db, 'incentives');
    await setSetting(db, 'incentives', body, req.auth.userId);
    const describe = (p: IncentiveSettings['closer']) =>
      p.slabs.length ? p.slabs.map((s) => `${s.from}+ at ${pkr(s.rate)}`).join(', ') : 'none';
    await writeAudit(db, req, {
      action: 'update',
      entity: 'incentive_plan',
      entityId: 'sales',
      summary: `updated the sales incentive slabs (closer: ${describe(body.closer)}; fronter: ${describe(body.fronter)})`,
      before,
      after: body,
    });
    return body;
  });

  /** One person's month: counts, incentive with its working, and the sales. */
  app.get('/people/:sipId', async (req) => {
    const { sipId } = z.object({ sipId: z.string().min(1) }).parse(req.params);
    const q = z.object({ month: month.default(todayISO().slice(0, 7)) }).parse(req.query);
    if (sipId !== req.auth.sipId && !can(req.auth, 'sales.view')) {
      if (!can(req.auth, 'team.view')) throw new ForbiddenError('Missing permission: sales.view');
      await assertCanReadEmployee(req.auth, sipId);
    }
    const { start, end } = monthBounds(q.month);
    const plan = await getSetting(db, 'incentives');
    const counts = (await salesCounts(db, q.month, [sipId])).get(sipId) ?? { closer: 0, fronter: 0 };
    const rows = await db
      .select(rowSelect)
      .from(sales)
      .innerJoin(employees, eq(sales.sipId, employees.sipId))
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .where(and(eq(sales.sipId, sipId), gte(sales.saleDate, start), lte(sales.saleDate, end)))
      .orderBy(desc(sales.saleDate), desc(sales.id))
      .limit(200);
    return { month: q.month, counts, incentive: incentiveOf(counts, plan), plan, sales: rows };
  });
}
