/**
 * Leave Management: applications and approvals, balances (a ledger), leave
 * types and the leave calendar settings. Mounted at /api/v1/leave.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, count, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { extname } from 'node:path';
import { z } from 'zod';
import { db, type DbOrTx } from '../db/client.js';
import { departments, employees, leaveApplications, leaveLedger, leaveTypes, LEAVE_STATUSES, ACCRUAL_RULES, users } from '../db/schema.js';
import { can, requirePermission, requireSelf } from '../auth/plugin.js';
import type { AuthContext } from '../auth/session.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { isISODate, todayISO, addDays } from '../lib/dates.js';
import { offsetOf, pageMeta, paginationSchema, type Pagination } from '../lib/pagination.js';
import { deleteUpload, saveUpload, sendUpload } from '../lib/uploads.js';
import { toCsv, sendCsv } from '../lib/csv.js';
import { writeAudit } from '../lib/audit.js';
import { employeeNameSql, fullName } from '../services/people.js';
import { getSetting, setSetting } from '../services/settings.js';
import { accrueAll, appendLedger, balancesFor } from '../services/leaveLedger.js';
import {
  APPLICATION_REF,
  REVERSAL_REF,
  assertCanReadLeave,
  canCancelRow,
  canDecideFor,
  canDecideRow,
  cancelApplication,
  daysPhrase,
  decideApplication,
  latestBalances,
  quote,
  round2,
  seesAllLeave,
  splitDays,
  submitApplication,
} from '../services/leave.js';

/* ------------------------------------------------------------------ */
/* Schemas                                                              */
/* ------------------------------------------------------------------ */

const isoDate = z.string().refine(isISODate, 'Use a YYYY-MM-DD date');
const sipParam = z.object({ sipId: z.string().trim().min(1).max(20) });
const idParam = z.object({ id: z.coerce.number().int().positive() });
const boolish = z.preprocess((v) => (v === 'true' || v === '1' || v === 'on' ? true : v === 'false' || v === '0' || v === '' ? false : v), z.boolean());

const applyBody = z.object({
  sipId: z.string().trim().min(1).max(20).optional(),
  leaveTypeId: z.coerce.number().int().positive(),
  startDate: isoDate,
  endDate: isoDate,
  halfDay: boolish.default(false),
  reason: z.string().trim().max(2000).optional().nullable(),
});

const quoteQuery = z.object({
  sipId: z.string().trim().min(1).max(20).optional(),
  leaveTypeId: z.coerce.number().int().positive(),
  startDate: isoDate,
  endDate: isoDate,
  halfDay: boolish.default(false),
});

const listQuery = paginationSchema.extend({
  scope: z.enum(['all', 'mine-to-approve']).default('all'),
  status: z.enum([...LEAVE_STATUSES, 'all']).default('all'),
  leaveTypeId: z.coerce.number().int().positive().optional(),
  sipId: z.string().trim().max(20).optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  search: z.string().trim().max(100).optional(),
});

const decisionBody = z.object({ comment: z.string().trim().max(1000).optional().nullable() }).default({});

const typeBody = z.object({
  name: z.string().trim().min(1).max(40),
  annualEntitlementDays: z.number().min(0).max(365),
  isPaid: z.boolean(),
  accrualRule: z.enum(ACCRUAL_RULES),
  carryForwardMax: z.number().min(0).max(365).default(0),
  requiresAttachment: z.boolean().default(false),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

/* ------------------------------------------------------------------ */
/* Application list                                                     */
/* ------------------------------------------------------------------ */

const approver = alias(users, 'approver');
const creator = alias(users, 'creator');

const appColumns = {
  id: leaveApplications.id,
  sipId: leaveApplications.sipId,
  employeeName: employeeNameSql,
  departmentName: departments.name,
  managerSipId: employees.managerSipId,
  leaveTypeId: leaveApplications.leaveTypeId,
  leaveTypeName: leaveTypes.name,
  isPaid: leaveTypes.isPaid,
  startDate: leaveApplications.startDate,
  endDate: leaveApplications.endDate,
  halfDay: leaveApplications.halfDay,
  totalDays: leaveApplications.totalDays,
  unpaidDays: leaveApplications.unpaidDays,
  reason: leaveApplications.reason,
  attachmentName: leaveApplications.attachmentName,
  status: leaveApplications.status,
  approverName: approver.name,
  decisionComment: leaveApplications.decisionComment,
  decidedAt: leaveApplications.decidedAt,
  createdByName: creator.name,
  createdAt: leaveApplications.createdAt,
};

type AppRow = Awaited<ReturnType<typeof selectApps>>[number];

function selectApps(tx: DbOrTx, where: SQL | undefined, order: SQL[], limit?: number, offset?: number) {
  const q = tx
    .select(appColumns)
    .from(leaveApplications)
    .innerJoin(employees, eq(leaveApplications.sipId, employees.sipId))
    .innerJoin(leaveTypes, eq(leaveApplications.leaveTypeId, leaveTypes.id))
    .leftJoin(departments, eq(employees.departmentId, departments.id))
    .leftJoin(approver, eq(leaveApplications.approverId, approver.id))
    .leftJoin(creator, eq(leaveApplications.createdBy, creator.id))
    .where(where)
    .orderBy(...order)
    .$dynamic();
  if (limit !== undefined) q.limit(limit);
  if (offset !== undefined) q.offset(offset);
  return q;
}

function countApps(tx: DbOrTx, where: SQL | undefined) {
  return tx
    .select({ n: count() })
    .from(leaveApplications)
    .innerJoin(employees, eq(leaveApplications.sipId, employees.sipId))
    .where(where);
}

/** Rows the user may see: all, or their direct reports (plus their own). */
function scopeFilter(auth: AuthContext): SQL | undefined {
  if (seesAllLeave(auth)) return undefined;
  if (can(auth, 'leave.approve.team') && auth.sipId) return eq(employees.managerSipId, auth.sipId);
  throw new ForbiddenError('Missing permission: leave.view or leave.approve');
}

/** The approver's queue: pending, not their own; team approvers only see direct reports. */
function queueFilter(auth: AuthContext): SQL {
  const notMine = auth.sipId ? ne(leaveApplications.sipId, auth.sipId) : undefined;
  if (can(auth, 'leave.approve')) return and(eq(leaveApplications.status, 'pending'), notMine)!;
  if (can(auth, 'leave.approve.team') && auth.sipId) {
    return and(eq(leaveApplications.status, 'pending'), notMine, eq(employees.managerSipId, auth.sipId))!;
  }
  return sql`false`;
}

/** Adds the ledger effect and the caller's allowed actions to each row. */
async function enrich(tx: DbOrTx, auth: AuthContext, rows: AppRow[]) {
  const balances = await latestBalances(tx, [...new Set(rows.map((r) => r.sipId))]);
  const approvedRefs = rows.filter((r) => r.status === 'approved' && r.isPaid).map((r) => APPLICATION_REF(r.id));
  const entries = approvedRefs.length
    ? await tx
        .select({ reference: leaveLedger.reference, days: leaveLedger.days, balanceAfter: leaveLedger.balanceAfter })
        .from(leaveLedger)
        .where(inArray(leaveLedger.reference, approvedRefs))
    : [];
  const byRef = new Map(entries.map((e) => [e.reference, e]));
  const today = todayISO();
  return rows.map((r) => {
    const balance = r.isPaid ? (balances.get(`${r.sipId}:${r.leaveTypeId}`) ?? 0) : null;
    let effect: { paidDays: number; unpaidDays: number; balanceAfter: number | null } | null = null;
    if (r.status === 'pending') {
      const s = splitDays(r.totalDays, r.isPaid, balance ?? 0);
      effect = { ...s, balanceAfter: balance === null ? null : round2(balance - s.paidDays) };
    } else if (r.status === 'approved') {
      const e = byRef.get(APPLICATION_REF(r.id));
      effect = { paidDays: e ? -e.days : 0, unpaidDays: r.unpaidDays, balanceAfter: e ? e.balanceAfter : balance };
    }
    const { managerSipId: _m, ...rest } = r;
    return {
      ...rest,
      hasAttachment: !!r.attachmentName,
      balance,
      effect,
      canDecide: canDecideRow(auth, r),
      canCancel: canCancelRow(auth, r, today),
    };
  });
}

async function listApps(auth: AuthContext, q: z.infer<typeof listQuery>, base: SQL | undefined) {
  const term = q.search ? `%${q.search}%` : null;
  const where = and(
    base,
    q.status !== 'all' ? eq(leaveApplications.status, q.status) : undefined,
    q.leaveTypeId ? eq(leaveApplications.leaveTypeId, q.leaveTypeId) : undefined,
    q.sipId ? eq(leaveApplications.sipId, q.sipId) : undefined,
    q.departmentId ? eq(employees.departmentId, q.departmentId) : undefined,
    q.from ? sql`${leaveApplications.endDate} >= ${q.from}` : undefined,
    q.to ? sql`${leaveApplications.startDate} <= ${q.to}` : undefined,
    term ? or(ilike(leaveApplications.sipId, term), ilike(employeeNameSql, term)) : undefined,
  );
  const order =
    q.scope === 'mine-to-approve'
      ? [asc(leaveApplications.createdAt)]
      : [desc(leaveApplications.createdAt), desc(leaveApplications.id)];
  const [rows, [{ n }]] = await Promise.all([
    selectApps(db, where, order, q.pageSize, offsetOf(q)),
    countApps(db, where),
  ]);
  return { data: await enrich(db, auth, rows), meta: pageMeta(q, Number(n)) };
}

async function getApp(auth: AuthContext, id: number) {
  const [row] = await selectApps(db, eq(leaveApplications.id, id), []);
  if (!row) throw new NotFoundError('Leave application not found');
  await assertCanReadLeave(auth, row.sipId);
  const [out] = await enrich(db, auth, [row]);
  const ledger = await db
    .select()
    .from(leaveLedger)
    .where(and(eq(leaveLedger.sipId, row.sipId), eq(leaveLedger.leaveTypeId, row.leaveTypeId), inArray(leaveLedger.reference, [APPLICATION_REF(id), REVERSAL_REF(id)])))
    .orderBy(asc(leaveLedger.id));
  return { ...out, ledger };
}

/* ------------------------------------------------------------------ */
/* Multipart                                                            */
/* ------------------------------------------------------------------ */

type Saved = Awaited<ReturnType<typeof saveUpload>>;

/** Reads a JSON body, or a multipart form with an optional `file` part. */
async function readApplyForm(req: FastifyRequest): Promise<{ fields: Record<string, unknown>; file: Saved | null }> {
  if (!req.isMultipart()) return { fields: (req.body as Record<string, unknown>) ?? {}, file: null };
  const fields: Record<string, unknown> = {};
  let file: Saved | null = null;
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (file || !part.filename) {
          part.file.resume();
          continue;
        }
        file = await saveUpload(part);
      } else {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (err) {
    if (file) await removeUpload(file.storedName);
    throw err;
  }
  return { fields, file };
}

async function removeUpload(storedName: string): Promise<void> {
  await deleteUpload(storedName).catch(() => undefined);
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

async function apply(req: FastifyRequest, forceSelf: boolean) {
  const { fields, file } = await readApplyForm(req);
  try {
    const body = applyBody.parse(fields);
    let sipId: string;
    if (forceSelf || !body.sipId || body.sipId === req.auth.sipId) {
      sipId = requireSelf(req);
    } else {
      if (!can(req.auth, 'leave.manage')) throw new ForbiddenError('Only HR can apply for leave on behalf of someone else');
      sipId = body.sipId;
    }
    return await db.transaction((tx) =>
      submitApplication(tx, req, {
        sipId,
        leaveTypeId: body.leaveTypeId,
        startDate: body.startDate,
        endDate: body.endDate,
        halfDay: body.halfDay,
        reason: body.reason ?? null,
        attachment: file ? { storedName: file.storedName, fileName: file.fileName } : null,
      }),
    );
  } catch (err) {
    if (file) await removeUpload(file.storedName);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Per-employee                                                         */
/* ------------------------------------------------------------------ */

async function ledgerFor(sipId: string, p: Pagination, leaveTypeId?: number) {
  const where = and(eq(leaveLedger.sipId, sipId), leaveTypeId ? eq(leaveLedger.leaveTypeId, leaveTypeId) : undefined);
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({
        id: leaveLedger.id,
        leaveTypeId: leaveLedger.leaveTypeId,
        leaveTypeName: leaveTypes.name,
        entryType: leaveLedger.entryType,
        days: leaveLedger.days,
        entryDate: leaveLedger.entryDate,
        reference: leaveLedger.reference,
        note: leaveLedger.note,
        balanceAfter: leaveLedger.balanceAfter,
        createdByName: users.name,
        createdAt: leaveLedger.createdAt,
      })
      .from(leaveLedger)
      .innerJoin(leaveTypes, eq(leaveLedger.leaveTypeId, leaveTypes.id))
      .leftJoin(users, eq(leaveLedger.createdBy, users.id))
      .where(where)
      .orderBy(desc(leaveLedger.id))
      .limit(p.pageSize)
      .offset(offsetOf(p)),
    db.select({ n: count() }).from(leaveLedger).where(where),
  ]);
  return { data: rows, meta: pageMeta(p, Number(n)) };
}

/** Balances with taken-this-year and pending days, for cards and the apply form. */
async function balanceCards(sipId: string) {
  const list = await balancesFor(db, sipId);
  const year = todayISO().slice(0, 4);
  const stats = await db
    .select({
      leaveTypeId: leaveApplications.leaveTypeId,
      taken: sql<number>`coalesce(sum(case when ${leaveApplications.status} = 'approved' then ${leaveApplications.totalDays} end), 0)::float8`,
      pending: sql<number>`coalesce(sum(case when ${leaveApplications.status} = 'pending' then ${leaveApplications.totalDays} end), 0)::float8`,
    })
    .from(leaveApplications)
    .where(and(eq(leaveApplications.sipId, sipId), sql`${leaveApplications.startDate} >= ${year + '-01-01'}`))
    .groupBy(leaveApplications.leaveTypeId);
  const byType = new Map(stats.map((s) => [s.leaveTypeId, s]));
  return list.map((b) => ({ ...b, takenThisYear: Number(byType.get(b.leaveTypeId)?.taken ?? 0), pending: Number(byType.get(b.leaveTypeId)?.pending ?? 0) }));
}

async function summaryFor(auth: AuthContext, sipId: string) {
  const [emp] = await db
    .select({ sipId: employees.sipId, name: employeeNameSql, status: employees.status, departmentName: departments.name, dateOfJoining: employees.dateOfJoining })
    .from(employees)
    .leftJoin(departments, eq(employees.departmentId, departments.id))
    .where(eq(employees.sipId, sipId));
  if (!emp) throw new NotFoundError('Employee not found');
  const [balances, apps, ledger] = await Promise.all([
    balanceCards(sipId),
    selectApps(db, eq(leaveApplications.sipId, sipId), [desc(leaveApplications.startDate), desc(leaveApplications.id)], 100),
    ledgerFor(sipId, { page: 1, pageSize: 100 }),
  ]);
  return { employee: emp, balances, applications: await enrich(db, auth, apps), ledger: ledger.data };
}

/* ------------------------------------------------------------------ */
/* Routes                                                               */
/* ------------------------------------------------------------------ */

const LIST_PERMS = ['leave.view', 'leave.approve', 'leave.approve.team', 'leave.manage'] as const;

export async function leaveRoutes(app: FastifyInstance): Promise<void> {
  const listGuard = { preHandler: requirePermission(...LIST_PERMS) };
  const manage = { preHandler: requirePermission('leave.manage') };

  /* ---------------- applications ---------------- */

  app.get('/applications', listGuard, async (req) => {
    const q = listQuery.parse(req.query);
    const base = q.scope === 'mine-to-approve' ? queueFilter(req.auth) : scopeFilter(req.auth);
    return listApps(req.auth, q, base);
  });

  app.get('/applications/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return getApp(req.auth, id);
  });

  app.post('/applications', async (req, reply) => {
    const row = await apply(req, false);
    return reply.status(201).send(await getApp(req.auth, row.id));
  });

  app.post('/applications/:id/approve', listGuard, async (req) => {
    const { id } = idParam.parse(req.params);
    const { comment } = decisionBody.parse(req.body ?? {});
    await db.transaction((tx) => decideApplication(tx, req, id, 'approved', comment ?? null));
    return getApp(req.auth, id);
  });

  app.post('/applications/:id/reject', listGuard, async (req) => {
    const { id } = idParam.parse(req.params);
    const { comment } = decisionBody.parse(req.body ?? {});
    await db.transaction((tx) => decideApplication(tx, req, id, 'rejected', comment ?? null));
    return getApp(req.auth, id);
  });

  app.post('/applications/:id/cancel', async (req) => {
    const { id } = idParam.parse(req.params);
    const { comment } = decisionBody.parse(req.body ?? {});
    await db.transaction((tx) => cancelApplication(tx, req, id, comment ?? null));
    return getApp(req.auth, id);
  });

  app.get('/applications/:id/attachment', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(leaveApplications).where(eq(leaveApplications.id, id));
    if (!row) throw new NotFoundError('Leave application not found');
    await assertCanReadLeave(req.auth, row.sipId);
    if (!row.attachmentStored || !row.attachmentName) throw new NotFoundError('This application has no attachment');
    const mimeType = MIME[extname(row.attachmentStored).toLowerCase()] ?? 'application/octet-stream';
    return sendUpload(reply, { storedName: row.attachmentStored, fileName: row.attachmentName, mimeType });
  });

  /** Live calculation for the apply form: days, balance, paid/unpaid split, overlaps. */
  app.get('/quote', async (req) => {
    const q = quoteQuery.parse(req.query);
    const sipId = q.sipId && q.sipId !== req.auth.sipId ? q.sipId : requireSelf(req);
    if (sipId !== req.auth.sipId && !can(req.auth, 'leave.manage')) throw new ForbiddenError('Only HR can apply for leave on behalf of someone else');
    return quote(db, { ...q, sipId });
  });

  /* ---------------- calendar lists ---------------- */

  app.get('/on-leave/today', listGuard, async (req) => {
    const today = todayISO();
    const where = and(
      scopeFilter(req.auth),
      eq(leaveApplications.status, 'approved'),
      sql`${leaveApplications.startDate} <= ${today} and ${leaveApplications.endDate} >= ${today}`,
    );
    const rows = await selectApps(db, where, [asc(leaveApplications.endDate)], 500);
    return { data: await enrich(db, req.auth, rows) };
  });

  app.get('/upcoming', listGuard, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);
    const today = todayISO();
    const until = addDays(today, days);
    const where = and(
      scopeFilter(req.auth),
      inArray(leaveApplications.status, ['approved', 'pending']),
      sql`${leaveApplications.startDate} > ${today} and ${leaveApplications.startDate} <= ${until}`,
    );
    const rows = await selectApps(db, where, [asc(leaveApplications.startDate)], 500);
    return { data: await enrich(db, req.auth, rows) };
  });

  /* ---------------- balances ---------------- */

  app.get('/balances', { preHandler: requirePermission('leave.view', 'leave.manage', 'leave.approve', 'leave.approve.team') }, async (req, reply) => {
    const q = z
      .object({
        search: z.string().trim().max(100).optional(),
        departmentId: z.coerce.number().int().positive().optional(),
        format: z.enum(['json', 'csv']).default('json'),
      })
      .parse(req.query);
    const term = q.search ? `%${q.search}%` : null;
    const types = await db
      .select({ id: leaveTypes.id, name: leaveTypes.name, entitlement: leaveTypes.annualEntitlementDays })
      .from(leaveTypes)
      .where(and(eq(leaveTypes.active, true), eq(leaveTypes.isPaid, true)))
      .orderBy(asc(leaveTypes.sortOrder), asc(leaveTypes.name));
    const people = await db
      .select({ sipId: employees.sipId, name: employeeNameSql, departmentName: departments.name, dateOfJoining: employees.dateOfJoining })
      .from(employees)
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .where(
        and(
          eq(employees.status, 'active'),
          scopeFilter(req.auth),
          q.departmentId ? eq(employees.departmentId, q.departmentId) : undefined,
          term ? or(ilike(employees.sipId, term), ilike(employeeNameSql, term)) : undefined,
        ),
      )
      .orderBy(asc(employees.firstName), asc(employees.lastName));
    const bal = await latestBalances(db, people.map((p) => p.sipId));
    const data = people.map((p) => ({
      ...p,
      balances: Object.fromEntries(types.map((t) => [String(t.id), bal.get(`${p.sipId}:${t.id}`) ?? 0])) as Record<string, number>,
    }));
    if (q.format === 'csv') {
      const csv = toCsv(
        ['SIP ID', 'Name', 'Department', ...types.map((t) => `${t.name} balance`)],
        data.map((d) => [d.sipId, d.name, d.departmentName, ...types.map((t) => d.balances[String(t.id)])]),
      );
      return sendCsv(reply, `leave-balances-${todayISO()}.csv`, csv);
    }
    return { types, data };
  });

  app.post('/adjustments', manage, async (req, reply) => {
    const body = z
      .object({
        sipId: z.string().trim().min(1).max(20),
        leaveTypeId: z.number().int().positive(),
        days: z.number().refine((n) => n !== 0 && Math.abs(n) <= 365, 'Enter a non-zero number of days up to 365'),
        note: z.string().trim().min(3, 'Say why the balance changes').max(500),
        entryDate: isoDate.optional(),
      })
      .parse(req.body);
    const row = await db.transaction(async (tx) => {
      const [emp] = await tx.select().from(employees).where(eq(employees.sipId, body.sipId));
      if (!emp) throw new NotFoundError('Employee not found');
      const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, body.leaveTypeId));
      if (!type) throw new NotFoundError('Leave type not found');
      if (!type.isPaid) throw new ValidationError(`${type.name} leave is unpaid and has no balance to adjust`);
      const days = round2(body.days);
      const entry = await appendLedger(tx, {
        sipId: emp.sipId,
        leaveTypeId: type.id,
        entryType: 'adjustment',
        days,
        entryDate: body.entryDate ?? todayISO(),
        note: body.note,
        createdBy: req.auth.userId,
      });
      await writeAudit(tx, req, {
        action: 'adjust',
        entity: 'leave_ledger',
        entityId: entry?.id,
        summary: `${days > 0 ? 'added' : 'removed'} ${daysPhrase(Math.abs(days))} of ${type.name.toLowerCase()} leave ${days > 0 ? 'to' : 'from'} ${fullName(emp)}'s balance`,
        after: entry,
      });
      return entry;
    });
    return reply.status(201).send(row);
  });

  app.post('/accruals/run', manage, async (req) => {
    const asOf = todayISO();
    const written = await db.transaction(async (tx) => {
      const n = await accrueAll(tx, asOf);
      await writeAudit(tx, req, {
        action: 'accrue',
        entity: 'leave_ledger',
        summary: n > 0 ? `ran leave accruals and wrote ${n} ledger ${n === 1 ? 'entry' : 'entries'}` : 'ran leave accruals, nothing was due',
        after: { asOf, written: n },
      });
      return n;
    });
    return { written, asOf };
  });

  /* ---------------- per employee ---------------- */

  app.get('/employees/:sipId/ledger', async (req) => {
    const { sipId } = sipParam.parse(req.params);
    await assertCanReadLeave(req.auth, sipId);
    const q = paginationSchema.extend({ leaveTypeId: z.coerce.number().int().positive().optional() }).parse(req.query);
    return ledgerFor(sipId, q, q.leaveTypeId);
  });

  app.get('/employees/:sipId/summary', async (req) => {
    const { sipId } = sipParam.parse(req.params);
    await assertCanReadLeave(req.auth, sipId);
    const out = await summaryFor(req.auth, sipId);
    return { ...out, canAdjust: can(req.auth, 'leave.manage'), canDecide: await canDecideFor(req.auth, sipId) };
  });

  /* ---------------- self-service ---------------- */

  app.get('/me/balances', async (req) => ({ data: await balanceCards(requireSelf(req)) }));

  app.get('/me/summary', async (req) => summaryFor(req.auth, requireSelf(req)));

  app.get('/me/applications', async (req) => {
    const sipId = requireSelf(req);
    const q = listQuery.parse(req.query);
    return listApps(req.auth, { ...q, sipId: undefined, scope: 'all' }, eq(leaveApplications.sipId, sipId));
  });

  app.get('/me/ledger', async (req) => {
    const sipId = requireSelf(req);
    const q = paginationSchema.extend({ leaveTypeId: z.coerce.number().int().positive().optional() }).parse(req.query);
    return ledgerFor(sipId, q, q.leaveTypeId);
  });

  app.post('/me/applications', async (req, reply) => {
    const row = await apply(req, true);
    return reply.status(201).send(await getApp(req.auth, row.id));
  });

  app.post('/me/applications/:id/cancel', async (req) => {
    const sipId = requireSelf(req);
    const { id } = idParam.parse(req.params);
    const { comment } = decisionBody.parse(req.body ?? {});
    const [row] = await db.select({ sipId: leaveApplications.sipId }).from(leaveApplications).where(eq(leaveApplications.id, id));
    if (!row || row.sipId !== sipId) throw new NotFoundError('Leave application not found');
    await db.transaction((tx) => cancelApplication(tx, req, id, comment ?? null));
    return getApp(req.auth, id);
  });

  /* ---------------- leave types ---------------- */

  app.get('/types', async (req) => {
    const { includeInactive } = z.object({ includeInactive: boolish.default(false) }).parse(req.query);
    const rows = await db
      .select({
        id: leaveTypes.id,
        name: leaveTypes.name,
        annualEntitlementDays: leaveTypes.annualEntitlementDays,
        isPaid: leaveTypes.isPaid,
        accrualRule: leaveTypes.accrualRule,
        carryForwardMax: leaveTypes.carryForwardMax,
        requiresAttachment: leaveTypes.requiresAttachment,
        active: leaveTypes.active,
        sortOrder: leaveTypes.sortOrder,
        applicationCount: sql<number>`(select count(*)::int from leave_applications a where a.leave_type_id = "leave_types"."id")`,
        ledgerCount: sql<number>`(select count(*)::int from leave_ledger l where l.leave_type_id = "leave_types"."id")`,
      })
      .from(leaveTypes)
      .where(includeInactive ? undefined : eq(leaveTypes.active, true))
      .orderBy(asc(leaveTypes.sortOrder), asc(leaveTypes.name));
    return { data: rows };
  });

  app.post('/types', manage, async (req, reply) => {
    const body = typeBody.parse(req.body);
    const row = await db.transaction(async (tx) => {
      const [row] = await tx.insert(leaveTypes).values(normaliseType(body)).returning();
      await writeAudit(tx, req, { action: 'create', entity: 'leave_type', entityId: row.id, summary: `added the ${row.name} leave type`, after: row });
      return row;
    });
    return reply.status(201).send(row);
  });

  app.patch('/types/:id', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = typeBody.partial().parse(req.body);
    return db.transaction(async (tx) => {
      const [before] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, id));
      if (!before) throw new NotFoundError('Leave type not found');
      if (body.isPaid !== undefined && body.isPaid !== before.isPaid) {
        const used = await typeUsage(tx, id);
        if (used > 0) throw new ValidationError('This type is already in use; its paid flag cannot change. Create a new type instead');
      }
      const [after] = await tx.update(leaveTypes).set(normaliseType({ ...before, ...body })).where(eq(leaveTypes.id, id)).returning();
      const summary =
        body.active === false && before.active
          ? `deactivated the ${after.name} leave type`
          : body.active === true && !before.active
            ? `reactivated the ${after.name} leave type`
            : `updated the ${after.name} leave type`;
      await writeAudit(tx, req, { action: 'update', entity: 'leave_type', entityId: id, summary, before, after });
      return after;
    });
  });

  /** Deletes an unused type; a type with ledger rows or applications is deactivated instead. */
  app.delete('/types/:id', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    return db.transaction(async (tx) => {
      const [before] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, id));
      if (!before) throw new NotFoundError('Leave type not found');
      if ((await typeUsage(tx, id)) > 0) {
        const [after] = await tx.update(leaveTypes).set({ active: false }).where(eq(leaveTypes.id, id)).returning();
        await writeAudit(tx, req, { action: 'deactivate', entity: 'leave_type', entityId: id, summary: `deactivated the ${before.name} leave type`, before, after });
        return { deleted: false, deactivated: true, type: after };
      }
      await tx.delete(leaveTypes).where(eq(leaveTypes.id, id));
      await writeAudit(tx, req, { action: 'delete', entity: 'leave_type', entityId: id, summary: `deleted the unused ${before.name} leave type`, before });
      return { deleted: true, deactivated: false, type: null };
    });
  });

  /* ---------------- settings ---------------- */

  app.get('/settings', async () => getSetting(db, 'leave'));

  app.put('/settings', manage, async (req) => {
    const body = z
      .object({
        weekendDays: z.array(z.number().int().min(0).max(6)).max(6, 'At least one day of the week must be a working day'),
        holidays: z.array(isoDate).max(366),
      })
      .parse(req.body);
    const value = { weekendDays: [...new Set(body.weekendDays)].sort(), holidays: [...new Set(body.holidays)].sort() };
    return db.transaction(async (tx) => {
      const before = await getSetting(tx, 'leave');
      await setSetting(tx, 'leave', value, req.auth.userId);
      await writeAudit(tx, req, { action: 'update', entity: 'settings', entityId: 'leave', summary: 'updated the leave calendar (weekends and public holidays)', before, after: value });
      return value;
    });
  });
}

function normaliseType<T extends z.infer<typeof typeBody>>(t: T) {
  return {
    name: t.name,
    annualEntitlementDays: t.isPaid ? t.annualEntitlementDays : 0,
    isPaid: t.isPaid,
    accrualRule: t.isPaid ? t.accrualRule : ('none' as const),
    carryForwardMax: t.isPaid ? t.carryForwardMax : 0,
    requiresAttachment: t.requiresAttachment,
    active: t.active,
    sortOrder: t.sortOrder,
  };
}

async function typeUsage(tx: DbOrTx, id: number): Promise<number> {
  const [[a], [l]] = await Promise.all([
    tx.select({ n: count() }).from(leaveApplications).where(eq(leaveApplications.leaveTypeId, id)),
    tx.select({ n: count() }).from(leaveLedger).where(eq(leaveLedger.leaveTypeId, id)),
  ]);
  return Number(a.n) + Number(l.n);
}
