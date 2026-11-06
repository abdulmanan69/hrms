/**
 * Payroll & salary engine: runs, payslips, salary structures, loans and
 * advances, payroll rules, and self-service payslips.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, count, desc, eq, gt, ilike, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, runInCompany, type DbOrTx } from '../db/client.js';
import {
  departments,
  designations,
  employees,
  loansAdvances,
  payrollRuns,
  payslipLines,
  payslips,
  salaryStructures,
} from '../db/schema.js';
import { can, requirePermission, requireSelf } from '../auth/plugin.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { isISODate, isMonth, todayISO } from '../lib/dates.js';
import { sendCsv, toCsv } from '../lib/csv.js';
import { offsetOf, pageMeta, paginationSchema } from '../lib/pagination.js';
import { employeeNameSql, fullName } from '../services/people.js';
import { getSetting, setSetting, type PayrollSettings } from '../services/settings.js';
import { A_COMPONENTS, AUTO_C_COMPONENTS } from '../services/payrollEngine.js';
import { ROLE_COMPONENT } from '../services/incentives.js';
import { renderPayslipsPdf } from '../services/payslipPdf.js';
import type { FastifyReply } from 'fastify';

function sendPdf(reply: FastifyReply, filename: string, pdf: Buffer, download: boolean): FastifyReply {
  return reply
    .header('content-type', 'application/pdf')
    .header('content-length', pdf.length)
    .header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/[^\w.-]/g, '_')}"`)
    .header('cache-control', 'private, no-store')
    .send(pdf);
}
import {
  approveRun,
  computeAndSave,
  computeRun,
  createRun,
  markRunPaid,
  runOut,
  dateLabel,
  loadContext,
  loanPosition,
  monthLabel,
  pkr,
  rebalanceLoans,
  runTotals,
  type PayslipSnapshot,
} from '../services/payrollService.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const sipParam = z.object({ sipId: z.string().trim().min(1).max(40) });
const isoDate = z.string().refine(isISODate, 'Use a YYYY-MM-DD date');
const money = z.number().int().min(0).max(100_000_000);

type Run = typeof payrollRuns.$inferSelect;

const actorOf = (req: FastifyRequest) => ({ userId: req.auth.userId, ip: req.ip });

async function getRun(tx: DbOrTx, id: number, lock = false): Promise<Run> {
  const q = tx.select().from(payrollRuns).where(eq(payrollRuns.id, id));
  const [run] = lock ? await q.for('update') : await q;
  if (!run) throw new NotFoundError('Payroll run not found');
  return run;
}

function assertDraft(run: Run): void {
  if (run.status !== 'draft') throw new ConflictError(`The ${monthLabel(run.periodMonth)} run is ${run.status} and cannot be changed`);
}

/** Last four characters only, for viewers without employees.sensitive. */
function mask(v: string | null): string | null {
  if (!v) return v;
  return v.length <= 4 ? '••••' : `•••• ${v.slice(-4)}`;
}

/** Full payslip for display. Access has been checked by the caller. */
async function payslipDetail(req: FastifyRequest, id: number) {
  const [row] = await db
    .select({ p: payslips, run: payrollRuns })
    .from(payslips)
    .innerJoin(payrollRuns, eq(payslips.runId, payrollRuns.id))
    .where(eq(payslips.id, id));
  if (!row) throw new NotFoundError('Payslip not found');
  const own = req.auth.sipId === row.p.sipId;
  if (!can(req.auth, 'payroll.view')) {
    if (!own) throw new ForbiddenError('You cannot view this payslip');
    if (row.run.status === 'draft') throw new NotFoundError('Payslip not found');
  }
  const lines = await db
    .select()
    .from(payslipLines)
    .where(eq(payslipLines.payslipId, id))
    .orderBy(asc(payslipLines.section), asc(payslipLines.isManual), asc(payslipLines.sortOrder), asc(payslipLines.id));
  const snap = row.p.snapshot as PayslipSnapshot;
  const sensitive = own || can(req.auth, 'employees.sensitive');
  const company = await getSetting(db, 'company');
  return {
    id: row.p.id,
    runId: row.run.id,
    periodMonth: row.run.periodMonth,
    runStatus: row.run.status,
    paidAt: row.run.paidAt,
    sipId: row.p.sipId,
    company: company.name,
    name: snap.name,
    departmentName: snap.departmentName,
    designationTitle: snap.designationTitle,
    employmentStatus: snap.employmentStatus,
    dateOfJoining: snap.dateOfJoining,
    bankName: snap.bankName,
    accountNo: sensitive ? snap.accountNo : mask(snap.accountNo),
    cnic: sensitive ? snap.cnic : null,
    basis: snap.basis,
    daysOfMonth: snap.daysOfMonth,
    calendarDays: snap.calendarDays,
    workingDays: snap.workingDays,
    periods: snap.periods,
    warnings: snap.warnings ?? [],
    currentSalaryDays: row.p.currentSalaryDays,
    newSalaryDays: row.p.newSalaryDays,
    notJoinedDays: row.p.notJoinedDays,
    unpaidDays: row.p.unpaidDays,
    grossA: row.p.grossA,
    totalAdditionsB: row.p.totalAdditionsB,
    totalDeductionsC: row.p.totalDeductionsC,
    netTotal: row.p.netTotal,
    computedAt: row.p.computedAt,
    lines: lines.map((l) => ({ id: l.id, section: l.section, component: l.component, amount: l.amount, isManual: l.isManual })),
  };
}

const payslipListCols = {
  id: payslips.id,
  runId: payslips.runId,
  periodMonth: payrollRuns.periodMonth,
  runStatus: payrollRuns.status,
  grossA: payslips.grossA,
  totalAdditionsB: payslips.totalAdditionsB,
  totalDeductionsC: payslips.totalDeductionsC,
  netTotal: payslips.netTotal,
  unpaidDays: payslips.unpaidDays,
  paidAt: payrollRuns.paidAt,
};

const structureCols = {
  id: salaryStructures.id,
  sipId: salaryStructures.sipId,
  effectiveFrom: salaryStructures.effectiveFrom,
  basicSalary: salaryStructures.basicSalary,
  houseRent: salaryStructures.houseRent,
  medicalAllowance: salaryStructures.medicalAllowance,
  petrolAllowance: salaryStructures.petrolAllowance,
  otherAllowance: salaryStructures.otherAllowance,
  grossSalary: salaryStructures.grossSalary,
  pfApplicable: salaryStructures.pfApplicable,
  eobiApplicable: salaryStructures.eobiApplicable,
  whtApplicable: salaryStructures.whtApplicable,
  note: salaryStructures.note,
  createdAt: salaryStructures.createdAt,
};

async function structureHistory(sipId: string) {
  const today = todayISO();
  const rows = await db.select(structureCols).from(salaryStructures).where(eq(salaryStructures.sipId, sipId)).orderBy(desc(salaryStructures.effectiveFrom));
  const current = rows.find((r) => r.effectiveFrom <= today) ?? null;
  return {
    current,
    history: rows.map((r) => ({ ...r, isCurrent: r.id === current?.id, isFuture: r.effectiveFrom > today })),
  };
}

async function getEmployee(sipId: string) {
  const [emp] = await db
    .select({
      sipId: employees.sipId,
      name: employeeNameSql,
      status: employees.status,
      dateOfJoining: employees.dateOfJoining,
      departmentName: departments.name,
      designationTitle: designations.title,
    })
    .from(employees)
    .leftJoin(departments, eq(employees.departmentId, departments.id))
    .leftJoin(designations, eq(employees.designationId, designations.id))
    .where(eq(employees.sipId, sipId));
  if (!emp) throw new NotFoundError('Employee not found');
  return emp;
}

const settingsSchema = z
  .object({
    pfPercentOfBasic: z.number().min(0).max(100),
    eobiEmployeeAmount: z.number().int().min(0).max(1_000_000),
    whtSlabs: z
      .array(
        z.object({
          from: z.number().int().min(0),
          to: z.number().int().min(0).nullable(),
          fixed: z.number().int().min(0),
          rate: z.number().min(0).max(100),
        }),
      )
      .min(1)
      .max(20),
    prorationBasis: z.enum(['calendar', 'working']),
  })
  .superRefine((s, ctx) => {
    const slabs = s.whtSlabs;
    if (slabs[0].from !== 0) ctx.addIssue({ code: 'custom', path: ['whtSlabs', 0, 'from'], message: 'The first slab must start at 0' });
    slabs.forEach((sl, i) => {
      if (sl.to !== null && sl.to <= sl.from) ctx.addIssue({ code: 'custom', path: ['whtSlabs', i, 'to'], message: `Slab ${i + 1} must end above where it starts` });
      if (i > 0 && slabs[i - 1].to !== sl.from)
        ctx.addIssue({ code: 'custom', path: ['whtSlabs', i, 'from'], message: `Slab ${i + 1} must start where slab ${i} ends` });
      if (sl.to === null && i !== slabs.length - 1) ctx.addIssue({ code: 'custom', path: ['whtSlabs', i, 'to'], message: 'Only the last slab can be open-ended' });
    });
    if (slabs[slabs.length - 1].to !== null) ctx.addIssue({ code: 'custom', path: ['whtSlabs'], message: 'The last slab must be open-ended' });
  });

export async function payrollRoutes(app: FastifyInstance): Promise<void> {
  const view = { preHandler: requirePermission('payroll.view') };
  const manage = { preHandler: requirePermission('payroll.manage') };
  const approve = { preHandler: requirePermission('payroll.approve') };

  /* ---------------------------------------------------------------- */
  /* Runs                                                               */
  /* ---------------------------------------------------------------- */

  app.get('/runs', view, async () => {
    const runs = await db.select().from(payrollRuns).orderBy(desc(payrollRuns.periodMonth));
    const totals = await runTotals(db, runs.map((r) => r.id));
    return { data: runs.map((r) => runOut(r, totals.get(r.id))) };
  });

  app.post('/runs', manage, async (req, reply) => {
    const body = z.object({ month: z.string().refine(isMonth, 'Use a YYYY-MM month'), notes: z.string().trim().max(500).optional() }).parse(req.body);
    const out = await db.transaction((tx) => createRun(tx, body.month, actorOf(req), body.notes));
    return reply.status(201).send(out);
  });

  app.get('/runs/:id', view, async (req) => {
    const { id } = idParam.parse(req.params);
    const run = await getRun(db, id);
    const totals = await runTotals(db, [id]);
    const rows = await db
      .select({
        id: payslips.id,
        sipId: payslips.sipId,
        snapshot: payslips.snapshot,
        currentSalaryDays: payslips.currentSalaryDays,
        newSalaryDays: payslips.newSalaryDays,
        notJoinedDays: payslips.notJoinedDays,
        unpaidDays: payslips.unpaidDays,
        grossA: payslips.grossA,
        totalAdditionsB: payslips.totalAdditionsB,
        totalDeductionsC: payslips.totalDeductionsC,
        netTotal: payslips.netTotal,
      })
      .from(payslips)
      .where(eq(payslips.runId, id));
    const comp = await db
      .select({ section: payslipLines.section, component: payslipLines.component, amount: sql<number>`sum(${payslipLines.amount})::int` })
      .from(payslipLines)
      .innerJoin(payslips, eq(payslipLines.payslipId, payslips.id))
      .where(eq(payslips.runId, id))
      .groupBy(payslipLines.section, payslipLines.component);
    const order = (s: string, c: string) => {
      const list: readonly string[] = s === 'A' ? A_COMPONENTS : s === 'C' ? AUTO_C_COMPONENTS : Object.values(ROLE_COMPONENT);
      const i = list.indexOf(c);
      return i === -1 ? 100 : i;
    };
    const ledger = (['A', 'B', 'C'] as const).map((section) => ({
      section,
      lines: comp
        .filter((c) => c.section === section)
        .sort((a, b) => order(section, a.component) - order(section, b.component) || b.amount - a.amount)
        .map((c) => ({ component: c.component, amount: c.amount })),
    }));
    const payslipRows = rows
      .map((r) => {
        const s = r.snapshot as PayslipSnapshot;
        return {
          id: r.id,
          sipId: r.sipId,
          name: s.name,
          departmentName: s.departmentName,
          designationTitle: s.designationTitle,
          paidDays: r.currentSalaryDays + r.newSalaryDays,
          hasIncrement: (s.periods?.length ?? 0) > 1,
          notJoinedDays: r.notJoinedDays,
          unpaidDays: r.unpaidDays,
          grossA: r.grossA,
          totalAdditionsB: r.totalAdditionsB,
          totalDeductionsC: r.totalDeductionsC,
          netTotal: r.netTotal,
          warnings: s.warnings ?? [],
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { run: runOut(run, totals.get(id)), ledger, payslips: payslipRows };
  });

  app.post('/runs/:id/recompute', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    return db.transaction(async (tx) => {
      const run = await getRun(tx, id, true);
      assertDraft(run);
      const result = await computeRun(tx, run);
      await writeAudit(tx, req, {
        action: 'recompute',
        entity: 'payroll_run',
        entityId: id,
        summary: `recomputed the ${monthLabel(run.periodMonth)} payroll run`,
        after: { payslips: result.count, removed: result.removed.length },
      });
      const totals = await runTotals(tx, [id]);
      return { run: runOut(run, totals.get(id)), skipped: result.skipped, removed: result.removed, negative: result.negative };
    });
  });

  app.delete('/runs/:id', manage, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await db.transaction(async (tx) => {
      const run = await getRun(tx, id, true);
      assertDraft(run);
      await tx.delete(payrollRuns).where(eq(payrollRuns.id, id));
      await writeAudit(tx, req, {
        action: 'delete',
        entity: 'payroll_run',
        entityId: id,
        summary: `deleted the draft ${monthLabel(run.periodMonth)} payroll run`,
        before: run,
      });
    });
    return reply.status(204).send();
  });

  app.post('/runs/:id/approve', approve, async (req) => {
    const { id } = idParam.parse(req.params);
    return db.transaction((tx) => approveRun(tx, id, actorOf(req)));
  });

  app.post('/runs/:id/pay', approve, async (req) => {
    const { id } = idParam.parse(req.params);
    return db.transaction((tx) => markRunPaid(tx, id, actorOf(req)));
  });

  app.post('/runs/:id/reopen', approve, async (req) => {
    const { id } = idParam.parse(req.params);
    return db.transaction(async (tx) => {
      const run = await getRun(tx, id, true);
      if (run.status !== 'approved') throw new ConflictError(run.status === 'paid' ? 'A paid run cannot be reopened' : 'The run is already a draft');
      const removed = await tx.delete(loansAdvances).where(eq(loansAdvances.runId, id)).returning({ sipId: loansAdvances.sipId });
      for (const sipId of new Set(removed.map((r) => r.sipId))) await rebalanceLoans(tx, sipId);
      const [after] = await tx
        .update(payrollRuns)
        .set({ status: 'draft', approvedBy: null, approvedAt: null, updatedAt: new Date() })
        .where(eq(payrollRuns.id, id))
        .returning();
      await writeAudit(tx, req, {
        action: 'reopen',
        entity: 'payroll_run',
        entityId: id,
        summary: `reopened the ${monthLabel(run.periodMonth)} payroll run`,
        before: { status: run.status },
        after: { status: after.status, loanDeductionsRemoved: removed.length },
      });
      const totals = await runTotals(tx, [id]);
      return { run: runOut(after, totals.get(id)) };
    });
  });

  async function runExportRows(id: number) {
    const slips = await db.select().from(payslips).where(eq(payslips.runId, id)).orderBy(asc(payslips.sipId));
    const lines = slips.length
      ? await db.select().from(payslipLines).where(inArray(payslipLines.payslipId, slips.map((s) => s.id)))
      : [];
    return { slips, lines };
  }

  app.get('/runs/:id/export.csv', view, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const run = await getRun(db, id);
    const { slips, lines } = await runExportRows(id);
    const comps = { B: new Set<string>(), C: new Set<string>() };
    for (const l of lines) if (l.section !== 'A') comps[l.section].add(l.component);
    const cCols = [...AUTO_C_COMPONENTS, ...[...comps.C].filter((c) => !(AUTO_C_COMPONENTS as readonly string[]).includes(c)).sort()];
    const bCols = [...comps.B].sort();
    const sensitive = can(req.auth, 'employees.sensitive');
    const headers = [
      'SIP ID',
      'Name',
      'Department',
      'Designation',
      ...(sensitive ? ['CNIC'] : []),
      'Days of month',
      'Current salary days',
      'New salary days',
      'Not joined days',
      'Unpaid days',
      ...A_COMPONENTS.map((c) => `A ${c}`),
      'A Gross earned',
      ...bCols.map((c) => `B ${c}`),
      'B Total additions',
      ...cCols.map((c) => `C ${c}`),
      'C Total deductions',
      'Net',
    ];
    const rows = slips.map((s) => {
      const snap = s.snapshot as PayslipSnapshot;
      const mine = lines.filter((l) => l.payslipId === s.id);
      const amt = (sec: string, c: string) => mine.filter((l) => l.section === sec && l.component === c).reduce((n, l) => n + l.amount, 0);
      return [
        s.sipId,
        snap.name,
        snap.departmentName,
        snap.designationTitle,
        ...(sensitive ? [snap.cnic] : []),
        snap.daysOfMonth,
        s.currentSalaryDays,
        s.newSalaryDays,
        s.notJoinedDays,
        s.unpaidDays,
        ...A_COMPONENTS.map((c) => amt('A', c)),
        s.grossA,
        ...bCols.map((c) => amt('B', c)),
        s.totalAdditionsB,
        ...cCols.map((c) => amt('C', c)),
        s.totalDeductionsC,
        s.netTotal,
      ];
    });
    return sendCsv(reply, `payroll-${run.periodMonth}.csv`, toCsv(headers, rows));
  });

  app.get('/runs/:id/bank.csv', approve, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const run = await getRun(db, id);
    if (run.status === 'draft') throw new ConflictError('Approve the run before downloading the bank file');
    const { slips } = await runExportRows(id);
    const rows = slips
      .filter((s) => s.netTotal > 0)
      .map((s) => {
        const snap = s.snapshot as PayslipSnapshot;
        return [s.sipId, snap.name, snap.bankName, snap.accountNo, s.netTotal];
      });
    return sendCsv(reply, `bank-transfer-${run.periodMonth}.csv`, toCsv(['SIP ID', 'Name', 'Bank', 'Account number', 'Net'], rows));
  });

  /* ---------------------------------------------------------------- */
  /* Payslips                                                           */
  /* ---------------------------------------------------------------- */

  // payroll.view, or the payslip's own employee once the run is approved
  app.get('/payslips/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!can(req.auth, 'payroll.view')) requireSelf(req);
    return payslipDetail(req, id);
  });

  // PDFs are rendered from the records on every request and never stored
  app.get('/payslips/:id/pdf', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { download } = z.object({ download: z.enum(['1', 'true']).optional() }).parse(req.query);
    if (!can(req.auth, 'payroll.view')) requireSelf(req);
    const p = await payslipDetail(req, id);
    const pdf = await renderPayslipsPdf([p], `Payslip ${p.sipId} ${p.periodMonth}`);
    return sendPdf(reply, `payslip-${p.sipId}-${p.periodMonth}.pdf`, pdf, !!download);
  });

  // platform route: the payslips are read inside the company transaction, and the
  // PDF is drawn after it closes, so a long run never holds a database connection
  app.get('/runs/:id/payslips.pdf', { ...view, config: { platform: true } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { run, all } = await runInCompany(req.auth.companyId, async () => {
      const run = await getRun(db, id);
      const ids = await db
        .select({ id: payslips.id })
        .from(payslips)
        .where(eq(payslips.runId, id))
        .orderBy(asc(payslips.sipId));
      if (ids.length === 0) throw new NotFoundError('This run has no payslips');
      const all = [];
      for (const r of ids) all.push(await payslipDetail(req, r.id));
      return { run, all };
    });
    const pdf = await renderPayslipsPdf(all, `Payslips ${run.periodMonth}`);
    return sendPdf(reply, `payslips-${run.periodMonth}.pdf`, pdf, true);
  });

  const lineBody = z.object({
    section: z.enum(['B', 'C']),
    component: z.string().trim().min(1).max(60),
    amount: money.refine((n) => n > 0, 'Enter an amount above 0'),
  });

  async function draftPayslip(tx: DbOrTx, payslipId: number) {
    const [p] = await tx.select().from(payslips).where(eq(payslips.id, payslipId));
    if (!p) throw new NotFoundError('Payslip not found');
    const run = await getRun(tx, p.runId, true);
    assertDraft(run);
    return { p, run };
  }

  function checkComponent(section: 'B' | 'C', component: string) {
    const reserved: readonly string[] = section === 'C' ? AUTO_C_COMPONENTS : Object.values(ROLE_COMPONENT);
    if (reserved.some((r) => r.toLowerCase() === component.toLowerCase())) {
      throw new ValidationError(
        section === 'C' ? `${component} is computed by the engine; add an Other deduction instead` : `${component} comes from recorded sales; record or void sales instead`,
      );
    }
  }

  /** Recompute after a manual line change; refuses a change that makes net negative. */
  async function recomputeOne(tx: DbOrTx, run: Run, sipId: string) {
    const ctx = await loadContext(tx);
    const { result } = await computeAndSave(tx, run, sipId, ctx);
    if (result.net < 0) throw new ValidationError(`That makes net pay negative (${pkr(result.net)})`);
    return result;
  }

  app.post('/payslips/:id/lines', manage, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = lineBody.parse(req.body);
    checkComponent(body.section, body.component);
    await db.transaction(async (tx) => {
      const { p, run } = await draftPayslip(tx, id);
      const [{ n }] = await tx.select({ n: count() }).from(payslipLines).where(eq(payslipLines.payslipId, id));
      const [line] = await tx
        .insert(payslipLines)
        .values({ payslipId: id, section: body.section, component: body.component, amount: body.amount, isManual: true, sortOrder: 100 + n })
        .returning();
      await recomputeOne(tx, run, p.sipId);
      const name = (p.snapshot as PayslipSnapshot).name;
      await writeAudit(tx, req, {
        action: 'add_line',
        entity: 'payslip',
        entityId: id,
        summary: `added ${body.component} of ${pkr(body.amount)} to ${name}'s ${monthLabel(run.periodMonth)} payslip`,
        after: line,
      });
    });
    return reply.status(201).send(await payslipDetail(req, id));
  });

  app.patch('/payslips/:id/lines/:lineId', manage, async (req) => {
    const { id, lineId } = z.object({ id: z.coerce.number().int(), lineId: z.coerce.number().int() }).parse(req.params);
    const body = z
      .object({ component: z.string().trim().min(1).max(60).optional(), amount: money.refine((n) => n > 0, 'Enter an amount above 0').optional() })
      .parse(req.body);
    await db.transaction(async (tx) => {
      const { p, run } = await draftPayslip(tx, id);
      const [before] = await tx.select().from(payslipLines).where(and(eq(payslipLines.id, lineId), eq(payslipLines.payslipId, id)));
      if (!before) throw new NotFoundError('Line not found');
      if (!before.isManual) throw new ValidationError('Computed lines cannot be edited');
      if (body.component) checkComponent(before.section as 'B' | 'C', body.component);
      const [after] = await tx.update(payslipLines).set(body).where(eq(payslipLines.id, lineId)).returning();
      await recomputeOne(tx, run, p.sipId);
      const name = (p.snapshot as PayslipSnapshot).name;
      await writeAudit(tx, req, {
        action: 'update_line',
        entity: 'payslip',
        entityId: id,
        summary: `changed ${after.component} to ${pkr(after.amount)} on ${name}'s ${monthLabel(run.periodMonth)} payslip`,
        before,
        after,
      });
    });
    return payslipDetail(req, id);
  });

  app.delete('/payslips/:id/lines/:lineId', manage, async (req) => {
    const { id, lineId } = z.object({ id: z.coerce.number().int(), lineId: z.coerce.number().int() }).parse(req.params);
    await db.transaction(async (tx) => {
      const { p, run } = await draftPayslip(tx, id);
      const [before] = await tx.select().from(payslipLines).where(and(eq(payslipLines.id, lineId), eq(payslipLines.payslipId, id)));
      if (!before) throw new NotFoundError('Line not found');
      if (!before.isManual) throw new ValidationError('Computed lines cannot be removed');
      await tx.delete(payslipLines).where(eq(payslipLines.id, lineId));
      await recomputeOne(tx, run, p.sipId);
      const name = (p.snapshot as PayslipSnapshot).name;
      await writeAudit(tx, req, {
        action: 'remove_line',
        entity: 'payslip',
        entityId: id,
        summary: `removed ${before.component} from ${name}'s ${monthLabel(run.periodMonth)} payslip`,
        before,
      });
    });
    return payslipDetail(req, id);
  });

  /* ---------------------------------------------------------------- */
  /* Self-service                                                       */
  /* ---------------------------------------------------------------- */

  app.get('/me/payslips', async (req) => {
    const sipId = requireSelf(req);
    const rows = await db
      .select(payslipListCols)
      .from(payslips)
      .innerJoin(payrollRuns, eq(payslips.runId, payrollRuns.id))
      .where(and(eq(payslips.sipId, sipId), ne(payrollRuns.status, 'draft')))
      .orderBy(desc(payrollRuns.periodMonth));
    return { data: rows };
  });

  /* ---------------------------------------------------------------- */
  /* Employee salary panel                                              */
  /* ---------------------------------------------------------------- */

  app.get('/employees/:sipId/salary', async (req) => {
    const { sipId } = sipParam.parse(req.params);
    const full = can(req.auth, 'payroll.view');
    if (!full && req.auth.sipId !== sipId) throw new ForbiddenError('You cannot view this salary');
    await getEmployee(sipId);
    const { current, history } = await structureHistory(sipId);
    const loan = await loanPosition(db, sipId);
    const slips = await db
      .select(payslipListCols)
      .from(payslips)
      .innerJoin(payrollRuns, eq(payslips.runId, payrollRuns.id))
      .where(and(eq(payslips.sipId, sipId), full ? undefined : ne(payrollRuns.status, 'draft')))
      .orderBy(desc(payrollRuns.periodMonth))
      .limit(6);
    return { current, history, loan, payslips: slips };
  });

  /* ---------------------------------------------------------------- */
  /* Salary structures                                                  */
  /* ---------------------------------------------------------------- */

  app.get('/structures', view, async (req) => {
    const q = paginationSchema
      .extend({
        search: z.string().trim().optional(),
        departmentId: z.coerce.number().int().optional(),
        missing: z.enum(['true', 'false']).optional(),
        status: z.enum(['active', 'pending', 'inactive', 'current']).default('current'),
      })
      .parse(req.query);
    const today = todayISO();
    const term = q.search ? `%${q.search}%` : null;
    const hasCurrent = sql`exists (select 1 from salary_structures ss where ss.sip_id = "employees"."sip_id" and ss.effective_from <= ${today})`;
    const where = and(
      q.status === 'current' ? inArray(employees.status, ['active', 'pending']) : eq(employees.status, q.status),
      q.departmentId ? eq(employees.departmentId, q.departmentId) : undefined,
      q.missing === 'true' ? sql`not ${hasCurrent}` : undefined,
      term ? or(ilike(employees.sipId, term), ilike(employeeNameSql, term)) : undefined,
    );
    const [{ total }] = await db.select({ total: count() }).from(employees).where(where);
    const emps = await db
      .select({
        sipId: employees.sipId,
        name: employeeNameSql,
        status: employees.status,
        dateOfJoining: employees.dateOfJoining,
        departmentName: departments.name,
        designationTitle: designations.title,
      })
      .from(employees)
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .leftJoin(designations, eq(employees.designationId, designations.id))
      .where(where)
      .orderBy(asc(employees.firstName), asc(employees.lastName))
      .limit(q.pageSize)
      .offset(offsetOf(q));
    const ids = emps.map((e) => e.sipId);
    const rows = ids.length
      ? await db.select(structureCols).from(salaryStructures).where(inArray(salaryStructures.sipId, ids)).orderBy(asc(salaryStructures.effectiveFrom))
      : [];
    const [{ missingCount }] = await db
      .select({ missingCount: count() })
      .from(employees)
      .where(and(inArray(employees.status, ['active', 'pending']), sql`not ${hasCurrent}`));
    const data = emps.map((e) => {
      const mine = rows.filter((r) => r.sipId === e.sipId);
      const past = mine.filter((r) => r.effectiveFrom <= today);
      return {
        ...e,
        current: past[past.length - 1] ?? null,
        next: mine.find((r) => r.effectiveFrom > today) ?? null,
        rows: mine.length,
      };
    });
    return { data, meta: { ...pageMeta(q, total), missing: missingCount } };
  });

  app.get('/structures/:sipId', view, async (req) => {
    const { sipId } = sipParam.parse(req.params);
    const employee = await getEmployee(sipId);
    const { current, history } = await structureHistory(sipId);
    return { employee, current, data: history };
  });

  app.post('/structures', manage, async (req, reply) => {
    const body = z
      .object({
        sipId: z.string().trim().min(1),
        effectiveFrom: isoDate,
        basicSalary: money.refine((n) => n > 0, 'Basic salary must be above 0'),
        houseRent: money.default(0),
        medicalAllowance: money.default(0),
        petrolAllowance: money.default(0),
        otherAllowance: money.default(0),
        pfApplicable: z.boolean().default(true),
        eobiApplicable: z.boolean().default(true),
        whtApplicable: z.boolean().default(true),
        note: z.string().trim().max(300).optional(),
      })
      .parse(req.body);
    const row = await db.transaction(async (tx) => {
      const [emp] = await tx.select().from(employees).where(eq(employees.sipId, body.sipId));
      if (!emp) throw new NotFoundError('Employee not found');
      if (emp.status === 'inactive') throw new ValidationError('This employee is inactive');
      if (body.effectiveFrom < emp.dateOfJoining) throw new ValidationError('The effective date cannot be before the joining date');
      const [locked] = await tx
        .select({ periodMonth: payrollRuns.periodMonth })
        .from(payrollRuns)
        .where(and(ne(payrollRuns.status, 'draft'), sql`${payrollRuns.periodMonth} >= ${body.effectiveFrom.slice(0, 7)}`))
        .orderBy(desc(payrollRuns.periodMonth))
        .limit(1);
      if (locked) {
        throw new ValidationError(`${monthLabel(locked.periodMonth)} payroll is already approved; pick a date after it or reopen that run`);
      }
      const [dupe] = await tx
        .select({ id: salaryStructures.id })
        .from(salaryStructures)
        .where(and(eq(salaryStructures.sipId, body.sipId), eq(salaryStructures.effectiveFrom, body.effectiveFrom)));
      if (dupe) throw new ConflictError('A salary row already starts on that date');
      const [prev] = await tx
        .select()
        .from(salaryStructures)
        .where(and(eq(salaryStructures.sipId, body.sipId), lte(salaryStructures.effectiveFrom, body.effectiveFrom)))
        .orderBy(desc(salaryStructures.effectiveFrom))
        .limit(1);
      const gross = body.basicSalary + body.houseRent + body.medicalAllowance + body.petrolAllowance + body.otherAllowance;
      const [created] = await tx
        .insert(salaryStructures)
        .values({ ...body, note: body.note ?? null, grossSalary: gross, createdBy: req.auth.userId })
        .returning();
      const name = fullName(emp);
      await writeAudit(tx, req, {
        action: prev ? 'increment' : 'create',
        entity: 'salary_structure',
        entityId: created.id,
        summary: prev
          ? `changed ${name}'s gross salary from ${pkr(prev.grossSalary)} to ${pkr(gross)} from ${dateLabel(body.effectiveFrom)}`
          : `set ${name}'s gross salary to ${pkr(gross)} from ${dateLabel(body.effectiveFrom)}`,
        before: prev ?? null,
        after: created,
      });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.delete('/structures/rows/:id', manage, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(salaryStructures).where(eq(salaryStructures.id, id));
      if (!row) throw new NotFoundError('Salary row not found');
      if (row.effectiveFrom <= todayISO()) throw new ValidationError('Only a future-dated salary row can be deleted');
      await tx.delete(salaryStructures).where(eq(salaryStructures.id, id));
      const [emp] = await tx.select().from(employees).where(eq(employees.sipId, row.sipId));
      await writeAudit(tx, req, {
        action: 'delete',
        entity: 'salary_structure',
        entityId: id,
        summary: `removed the salary change for ${emp ? fullName(emp) : row.sipId} planned from ${dateLabel(row.effectiveFrom)}`,
        before: row,
      });
    });
    return reply.status(204).send();
  });

  /* ---------------------------------------------------------------- */
  /* Loans and advances                                                 */
  /* ---------------------------------------------------------------- */

  app.get('/loans', view, async (req) => {
    const q = z.object({ search: z.string().trim().optional(), all: z.enum(['true', 'false']).optional() }).parse(req.query);
    const term = q.search ? `%${q.search}%` : null;
    const rows = await db
      .select({
        sipId: loansAdvances.sipId,
        balance: loansAdvances.balanceAfter,
        lastEntryDate: loansAdvances.entryDate,
        name: employeeNameSql,
        status: employees.status,
        departmentName: departments.name,
      })
      .from(loansAdvances)
      .innerJoin(employees, eq(loansAdvances.sipId, employees.sipId))
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .where(
        and(
          sql`${loansAdvances.id} in (select max(id) from ${loansAdvances} group by ${loansAdvances.sipId})`,
          q.all === 'true' ? undefined : gt(loansAdvances.balanceAfter, 0),
          term ? or(ilike(employees.sipId, term), ilike(employeeNameSql, term)) : undefined,
        ),
      )
      .orderBy(desc(loansAdvances.balanceAfter));
    const data = [];
    for (const r of rows) {
      const pos = await loanPosition(db, r.sipId);
      data.push({ ...r, installment: pos.installment });
    }
    return { data };
  });

  app.get('/loans/:sipId', view, async (req) => {
    const { sipId } = sipParam.parse(req.params);
    const employee = await getEmployee(sipId);
    const rows = await db
      .select({
        id: loansAdvances.id,
        entryType: loansAdvances.entryType,
        amount: loansAdvances.amount,
        installment: loansAdvances.installment,
        entryDate: loansAdvances.entryDate,
        runId: loansAdvances.runId,
        periodMonth: payrollRuns.periodMonth,
        note: loansAdvances.note,
        balanceAfter: loansAdvances.balanceAfter,
        createdAt: loansAdvances.createdAt,
      })
      .from(loansAdvances)
      .leftJoin(payrollRuns, eq(loansAdvances.runId, payrollRuns.id))
      .where(eq(loansAdvances.sipId, sipId))
      .orderBy(desc(loansAdvances.id));
    const pos = await loanPosition(db, sipId);
    return { employee, ...pos, data: rows };
  });

  app.post('/loans', manage, async (req, reply) => {
    const body = z
      .object({
        sipId: z.string().trim().min(1),
        type: z.enum(['loan', 'advance']),
        amount: money.refine((n) => n > 0, 'Enter an amount above 0'),
        installment: money.refine((n) => n > 0, 'Enter a monthly installment above 0'),
        entryDate: isoDate,
        note: z.string().trim().max(300).optional(),
      })
      .refine((b) => b.installment <= b.amount, { path: ['installment'], message: 'The installment cannot exceed the amount' })
      .parse(req.body);
    const row = await db.transaction(async (tx) => {
      const [emp] = await tx.select().from(employees).where(eq(employees.sipId, body.sipId)).for('update');
      if (!emp) throw new NotFoundError('Employee not found');
      if (emp.status === 'inactive') throw new ValidationError('This employee is inactive');
      const pos = await loanPosition(tx, body.sipId);
      const [created] = await tx
        .insert(loansAdvances)
        .values({
          sipId: body.sipId,
          entryType: body.type,
          amount: body.amount,
          installment: body.installment,
          entryDate: body.entryDate,
          note: body.note ?? null,
          balanceAfter: pos.balance + body.amount,
          createdBy: req.auth.userId,
        })
        .returning();
      await writeAudit(tx, req, {
        action: 'create',
        entity: 'loan',
        entityId: created.id,
        summary: `gave ${fullName(emp)} ${body.type === 'loan' ? 'a loan' : 'an advance'} of ${pkr(body.amount)}, ${pkr(body.installment)} a month`,
        after: created,
      });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.post('/loans/:sipId/entries', manage, async (req, reply) => {
    const { sipId } = sipParam.parse(req.params);
    const body = z
      .object({
        type: z.enum(['repayment', 'waiver']),
        amount: money.refine((n) => n > 0, 'Enter an amount above 0'),
        entryDate: isoDate,
        note: z.string().trim().max(300).optional(),
      })
      .parse(req.body);
    const row = await db.transaction(async (tx) => {
      const [emp] = await tx.select().from(employees).where(eq(employees.sipId, sipId)).for('update');
      if (!emp) throw new NotFoundError('Employee not found');
      const pos = await loanPosition(tx, sipId);
      if (body.amount > pos.balance) throw new ValidationError(`The outstanding balance is ${pkr(pos.balance)}`);
      const [created] = await tx
        .insert(loansAdvances)
        .values({
          sipId,
          entryType: body.type === 'waiver' ? 'waiver' : 'deduction',
          amount: -body.amount,
          entryDate: body.entryDate,
          note: body.note ?? (body.type === 'repayment' ? 'Manual repayment' : null),
          balanceAfter: pos.balance - body.amount,
          createdBy: req.auth.userId,
        })
        .returning();
      await writeAudit(tx, req, {
        action: body.type,
        entity: 'loan',
        entityId: created.id,
        summary:
          body.type === 'waiver'
            ? `waived ${pkr(body.amount)} of ${fullName(emp)}'s loan balance`
            : `recorded a loan repayment of ${pkr(body.amount)} from ${fullName(emp)}`,
        after: created,
      });
      return created;
    });
    return reply.status(201).send(row);
  });

  /* ---------------------------------------------------------------- */
  /* Payroll rules                                                      */
  /* ---------------------------------------------------------------- */

  app.get('/settings', { preHandler: requirePermission('payroll.view', 'payroll.manage', 'settings.manage') }, async () => {
    const payroll = await getSetting(db, 'payroll');
    const leave = await getSetting(db, 'leave');
    return { ...payroll, weekendDays: leave.weekendDays };
  });

  app.put('/settings', { preHandler: requirePermission('payroll.manage', 'settings.manage') }, async (req) => {
    const body = settingsSchema.parse(req.body) as PayrollSettings;
    await db.transaction(async (tx) => {
      const before = await getSetting(tx, 'payroll');
      await setSetting(tx, 'payroll', body, req.auth.userId);
      await writeAudit(tx, req, { action: 'update', entity: 'settings', entityId: 'payroll', summary: 'updated the payroll rules', before, after: body });
    });
    const leave = await getSetting(db, 'leave');
    return { ...body, weekendDays: leave.weekendDays };
  });
}

