/**
 * Database side of payroll: loads what the engine needs for one employee and
 * month, runs it, and stores the payslip with its lines and snapshot.
 */
import { and, asc, desc, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { config } from '../config.js';
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
import { daysInMonth, monthBounds, workingDaysBetween } from '../lib/dates.js';
import { notify, writeAudit } from '../lib/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { computePayslip, type EngineResult } from './payrollEngine.js';
import { unpaidDaysByMonth } from './leaveUnpaid.js';
import { fullName, userIdForSip, userIdsWithPermission } from './people.js';
import { getSetting, type LeaveSettings, type PayrollSettings } from './settings.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-11' → 'November 2026' */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** 55161 → '55,161' */
export function pkr(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export interface PayrollContext {
  payroll: PayrollSettings;
  leave: LeaveSettings;
}

export async function loadContext(tx: DbOrTx): Promise<PayrollContext> {
  return { payroll: await getSetting(tx, 'payroll'), leave: await getSetting(tx, 'leave') };
}

/* ------------------------------------------------------------------ */
/* Loans                                                                */
/* ------------------------------------------------------------------ */

/** Outstanding balance and the installment of the latest loan/advance given. */
export async function loanPosition(tx: DbOrTx, sipId: string): Promise<{ balance: number; installment: number }> {
  const [last] = await tx
    .select({ balance: loansAdvances.balanceAfter })
    .from(loansAdvances)
    .where(eq(loansAdvances.sipId, sipId))
    .orderBy(desc(loansAdvances.id))
    .limit(1);
  const [given] = await tx
    .select({ installment: loansAdvances.installment })
    .from(loansAdvances)
    .where(and(eq(loansAdvances.sipId, sipId), inArray(loansAdvances.entryType, ['loan', 'advance']), isNotNull(loansAdvances.installment)))
    .orderBy(desc(loansAdvances.id))
    .limit(1);
  return { balance: last?.balance ?? 0, installment: given?.installment ?? 0 };
}

/** Recomputes balance_after on every ledger row of an employee (after a row is removed). */
export async function rebalanceLoans(tx: DbOrTx, sipId: string): Promise<void> {
  const rows = await tx.select().from(loansAdvances).where(eq(loansAdvances.sipId, sipId)).orderBy(asc(loansAdvances.id));
  let bal = 0;
  for (const r of rows) {
    bal += r.amount;
    if (r.balanceAfter !== bal) await tx.update(loansAdvances).set({ balanceAfter: bal }).where(eq(loansAdvances.id, r.id));
  }
}

/* ------------------------------------------------------------------ */
/* Eligibility                                                          */
/* ------------------------------------------------------------------ */

export interface Skipped {
  sipId: string;
  name: string;
  reason: string;
}

/**
 * Who gets a payslip for a month: active employees who joined by month end
 * and have a salary structure effective by month end. Pending hires and
 * active staff without a structure are returned as skipped.
 */
export async function eligibleFor(tx: DbOrTx, month: string): Promise<{ sipIds: string[]; skipped: Skipped[] }> {
  const { start, end } = monthBounds(month);
  const rows = await tx
    .select({
      sipId: employees.sipId,
      firstName: employees.firstName,
      middleInitial: employees.middleInitial,
      lastName: employees.lastName,
      status: employees.status,
      hasStructure: sql<boolean>`exists (select 1 from salary_structures ss where ss.sip_id = "employees"."sip_id" and ss.effective_from <= ${end})`,
    })
    .from(employees)
    .where(
      and(
        lte(employees.dateOfJoining, end),
        or(
          inArray(employees.status, ['active', 'pending']),
          // someone who left during (or after) this month is still paid for the days worked
          and(eq(employees.status, 'inactive'), sql`(${employees.deactivatedAt} at time zone ${config.TZ_BUSINESS})::date >= ${start}::date`),
        ),
      ),
    )
    .orderBy(asc(employees.sipId));
  const sipIds: string[] = [];
  const skipped: Skipped[] = [];
  for (const r of rows) {
    const name = fullName(r);
    if (r.status === 'pending') skipped.push({ sipId: r.sipId, name, reason: 'Pending activation' });
    else if (!r.hasStructure) skipped.push({ sipId: r.sipId, name, reason: 'No salary structure' });
    else sipIds.push(r.sipId);
  }
  return { sipIds, skipped };
}

/* ------------------------------------------------------------------ */
/* Compute one payslip                                                  */
/* ------------------------------------------------------------------ */

export interface PayslipSnapshot {
  name: string;
  departmentName: string | null;
  designationTitle: string | null;
  employmentStatus: string;
  dateOfJoining: string;
  bankName: string | null;
  accountNo: string | null;
  cnic: string | null;
  basis: 'calendar' | 'working';
  calendarDays: number;
  workingDays: number;
  daysOfMonth: number;
  periods: EngineResult['periods'];
  warnings: string[];
}

type Run = typeof payrollRuns.$inferSelect;

/** Computes and stores the payslip for one employee in a draft run. Manual lines are kept. */
export async function computeAndSave(
  tx: DbOrTx,
  run: Run,
  sipId: string,
  ctx: PayrollContext,
  /** unpaid leave days this month; looked up with unpaidDaysByMonth when omitted */
  unpaidDays?: number,
): Promise<{ payslipId: number; result: EngineResult }> {
  const { end } = monthBounds(run.periodMonth);
  const [emp] = await tx
    .select({ e: employees, departmentName: departments.name, designationTitle: designations.title })
    .from(employees)
    .leftJoin(departments, eq(employees.departmentId, departments.id))
    .leftJoin(designations, eq(employees.designationId, designations.id))
    .where(eq(employees.sipId, sipId));
  if (!emp) throw new Error(`employee ${sipId} not found`);

  const structures = await tx
    .select()
    .from(salaryStructures)
    .where(and(eq(salaryStructures.sipId, sipId), lte(salaryStructures.effectiveFrom, end)))
    .orderBy(asc(salaryStructures.effectiveFrom));
  const unpaid = unpaidDays ?? (await unpaidDaysByMonth(tx, run.periodMonth, [sipId])).get(sipId) ?? 0;
  const loan = await loanPosition(tx, sipId);

  const [existing] = await tx.select().from(payslips).where(and(eq(payslips.runId, run.id), eq(payslips.sipId, sipId)));
  const manual = existing
    ? await tx
        .select()
        .from(payslipLines)
        .where(and(eq(payslipLines.payslipId, existing.id), eq(payslipLines.isManual, true)))
        .orderBy(asc(payslipLines.sortOrder), asc(payslipLines.id))
    : [];

  // the deactivation date (in business time) is the last paid day
  const lastWorkingDay =
    emp.e.status === 'inactive' && emp.e.deactivatedAt
      ? new Intl.DateTimeFormat('en-CA', { timeZone: config.TZ_BUSINESS }).format(emp.e.deactivatedAt)
      : null;
  const result = computePayslip({
    month: run.periodMonth,
    dateOfJoining: emp.e.dateOfJoining,
    lastWorkingDay,
    structures,
    unpaidDays: unpaid,
    settings: ctx.payroll,
    weekendDays: ctx.leave.weekendDays,
    holidays: ctx.leave.holidays,
    loan,
    manualLines: manual.map((l) => ({ section: l.section as 'B' | 'C', component: l.component, amount: l.amount })),
  });

  const snapshot: PayslipSnapshot = {
    name: fullName(emp.e),
    departmentName: emp.departmentName,
    designationTitle: emp.designationTitle,
    employmentStatus: emp.e.employmentStatus,
    dateOfJoining: emp.e.dateOfJoining,
    bankName: emp.e.bankName,
    accountNo: emp.e.accountNo,
    cnic: emp.e.cnic,
    basis: result.basis,
    calendarDays: result.calendarDays,
    workingDays: result.workingDays,
    daysOfMonth: result.daysOfMonth,
    periods: result.periods,
    warnings: result.warnings,
  };
  const values = {
    currentSalaryDays: result.currentSalaryDays,
    newSalaryDays: result.newSalaryDays,
    notJoinedDays: result.notJoinedDays,
    unpaidDays: result.unpaidDays,
    grossA: result.grossA,
    totalAdditionsB: result.totalB,
    totalDeductionsC: result.totalC,
    netTotal: result.net,
    snapshot,
    computedAt: new Date(),
  };

  let payslipId: number;
  if (existing) {
    payslipId = existing.id;
    await tx.update(payslips).set(values).where(eq(payslips.id, payslipId));
    await tx.delete(payslipLines).where(and(eq(payslipLines.payslipId, payslipId), eq(payslipLines.isManual, false)));
  } else {
    const [row] = await tx.insert(payslips).values({ runId: run.id, sipId, ...values }).returning({ id: payslips.id });
    payslipId = row.id;
  }
  const auto = result.lines.filter((l) => !l.isManual);
  if (auto.length) {
    await tx.insert(payslipLines).values(auto.map((l) => ({ payslipId, section: l.section, component: l.component, amount: l.amount, isManual: false, sortOrder: l.sortOrder })));
  }
  return { payslipId, result };
}

/**
 * Recomputes a draft run: every eligible employee gets a fresh payslip
 * (manual lines kept), payslips of people no longer eligible are removed.
 */
export async function computeRun(
  tx: DbOrTx,
  run: Run,
): Promise<{ count: number; skipped: Skipped[]; removed: Skipped[]; negative: Array<{ sipId: string; name: string; net: number }> }> {
  const ctx = await loadContext(tx);
  const { sipIds, skipped } = await eligibleFor(tx, run.periodMonth);
  const negative: Array<{ sipId: string; name: string; net: number }> = [];
  const unpaid = sipIds.length ? await unpaidDaysByMonth(tx, run.periodMonth, sipIds) : new Map<string, number>();
  for (const sipId of sipIds) {
    const { result } = await computeAndSave(tx, run, sipId, ctx, unpaid.get(sipId) ?? 0);
    if (result.net < 0) negative.push({ sipId, name: '', net: result.net });
  }
  const stale = await tx
    .select({ id: payslips.id, sipId: payslips.sipId, snapshot: payslips.snapshot })
    .from(payslips)
    .where(eq(payslips.runId, run.id));
  const keep = new Set(sipIds);
  const removed: Skipped[] = [];
  for (const s of stale) {
    if (keep.has(s.sipId)) continue;
    await tx.delete(payslips).where(eq(payslips.id, s.id));
    removed.push({ sipId: s.sipId, name: (s.snapshot as PayslipSnapshot).name ?? s.sipId, reason: 'No longer eligible' });
  }
  if (negative.length) {
    const names = await tx.select({ sipId: payslips.sipId, snapshot: payslips.snapshot }).from(payslips).where(eq(payslips.runId, run.id));
    const byId = new Map(names.map((n) => [n.sipId, (n.snapshot as PayslipSnapshot).name]));
    for (const n of negative) n.name = byId.get(n.sipId) ?? n.sipId;
  }
  const { start, end } = monthBounds(run.periodMonth);
  const working = workingDaysBetween(start, end, ctx.leave.weekendDays, ctx.leave.holidays);
  await tx.update(payrollRuns).set({ workingDays: working, updatedAt: new Date() }).where(eq(payrollRuns.id, run.id));
  return { count: sipIds.length, skipped, removed, negative };
}

/** Section totals and headcount for a set of runs. */
export async function runTotals(tx: DbOrTx, runIds: number[]) {
  if (runIds.length === 0) return new Map<number, { headcount: number; a: number; b: number; c: number; net: number }>();
  const rows = await tx
    .select({
      runId: payslips.runId,
      headcount: sql<number>`count(*)::int`,
      a: sql<number>`coalesce(sum(${payslips.grossA}), 0)::int`,
      b: sql<number>`coalesce(sum(${payslips.totalAdditionsB}), 0)::int`,
      c: sql<number>`coalesce(sum(${payslips.totalDeductionsC}), 0)::int`,
      net: sql<number>`coalesce(sum(${payslips.netTotal}), 0)::int`,
    })
    .from(payslips)
    .where(inArray(payslips.runId, runIds))
    .groupBy(payslips.runId);
  return new Map(rows.map((r) => [r.runId, r]));
}

/** '2026-07-16' → 'Jul 16, 2026' for audit summaries */
export function dateLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`;
}

/* ------------------------------------------------------------------ */
/* Run lifecycle: routes and seed scripts call these in a transaction  */
/* ------------------------------------------------------------------ */

/** Who is acting: the user's id (null for a seed or system script) and IP. */
export type PayrollActor = { userId: number | null; ip?: string | null };

type Totals = { headcount: number; a: number; b: number; c: number; net: number };

export function runOut(run: Run, t?: Totals) {
  return {
    id: run.id,
    periodMonth: run.periodMonth,
    status: run.status,
    daysOfMonth: run.daysOfMonth,
    workingDays: run.workingDays,
    notes: run.notes,
    createdAt: run.createdAt,
    approvedAt: run.approvedAt,
    paidAt: run.paidAt,
    headcount: t?.headcount ?? 0,
    totalA: t?.a ?? 0,
    totalB: t?.b ?? 0,
    totalC: t?.c ?? 0,
    totalNet: t?.net ?? 0,
  };
}

export type RunSummary = ReturnType<typeof runOut>;

/**
 * Creates the draft run for a month ('YYYY-MM') and computes every eligible
 * payslip. Writes the audit row and notifies payroll.approve holders (not the
 * actor). Throws ConflictError if the month already has a run.
 * Call inside db.transaction.
 */
export async function createRun(
  tx: DbOrTx,
  month: string,
  actor: PayrollActor,
  notes?: string | null,
): Promise<{ run: RunSummary; skipped: Skipped[]; negative: Array<{ sipId: string; name: string; net: number }> }> {
  const label = monthLabel(month);
  const [dupe] = await tx.select({ id: payrollRuns.id }).from(payrollRuns).where(eq(payrollRuns.periodMonth, month));
  if (dupe) throw new ConflictError(`A payroll run for ${label} already exists`);
  const leave = await getSetting(tx, 'leave');
  const { start, end } = monthBounds(month);
  const [run] = await tx
    .insert(payrollRuns)
    .values({
      periodMonth: month,
      daysOfMonth: daysInMonth(month),
      workingDays: workingDaysBetween(start, end, leave.weekendDays, leave.holidays),
      notes: notes ?? null,
      createdBy: actor.userId,
    })
    .returning();
  const result = await computeRun(tx, run);
  await writeAudit(tx, actor, {
    action: 'create',
    entity: 'payroll_run',
    entityId: run.id,
    summary: `created the ${label} payroll run`,
    after: { periodMonth: run.periodMonth, payslips: result.count, skipped: result.skipped.length },
  });
  const approvers = await userIdsWithPermission(tx, 'payroll.approve');
  await notify(
    tx,
    approvers.filter((u) => u !== actor.userId),
    { title: `${label} payroll run is ready for review`, body: `${result.count} payslips in draft`, link: `/payroll/runs/${run.id}` },
  );
  const totals = await runTotals(tx, [run.id]);
  return { run: runOut(run, totals.get(run.id)), skipped: result.skipped, negative: result.negative };
}

async function lockRun(tx: DbOrTx, id: number): Promise<Run> {
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).for('update');
  if (!run) throw new NotFoundError('Payroll run not found');
  return run;
}

/**
 * Approves a draft run. Refuses negative nets, writes a loan `deduction` row
 * (with run_id and the new balance) for each payslip's loan installment, and
 * locks the run. Call inside db.transaction.
 */
/** Thrown to undo the trial recompute in draftIsStale. */
class TrialRollback extends Error {}

/**
 * What a fresh compute would change in a draft run, as a short description,
 * or null when nothing would. Leaves the run exactly as it was.
 */
async function draftIsStale(tx: DbOrTx, run: Run, slips: Array<typeof payslips.$inferSelect>): Promise<string | null> {
  const before = new Map(slips.map((s) => [s.sipId, s.netTotal]));
  let changed: string | null = null;
  try {
    await tx.transaction(async (sp) => {
      await computeRun(sp, run);
      const after = await sp.select({ sipId: payslips.sipId, net: payslips.netTotal, snapshot: payslips.snapshot }).from(payslips).where(eq(payslips.runId, run.id));
      const diffs = after.filter((a) => before.get(a.sipId) !== a.net);
      const added = after.length - slips.length;
      if (diffs.length || added) {
        const first = diffs[0] ? (diffs[0].snapshot as PayslipSnapshot).name : null;
        changed = first ? `${diffs.length} payslip${diffs.length === 1 ? '' : 's'}, e.g. ${first}` : `${Math.abs(added)} payslip(s) added or removed`;
      }
      throw new TrialRollback();
    });
  } catch (err) {
    if (!(err instanceof TrialRollback)) throw err;
  }
  return changed;
}

export async function approveRun(tx: DbOrTx, runId: number, actor: PayrollActor): Promise<{ run: RunSummary }> {
  const run = await lockRun(tx, runId);
  const label = monthLabel(run.periodMonth);
  if (run.status !== 'draft') throw new ConflictError(`The ${label} run is ${run.status} and cannot be changed`);
  const slips = await tx.select().from(payslips).where(eq(payslips.runId, runId));
  if (slips.length === 0) throw new ValidationError(`The ${label} run has no payslips`);
  const neg = slips.filter((s) => s.netTotal < 0);
  if (neg.length) {
    const names = neg.map((s) => (s.snapshot as PayslipSnapshot).name).join(', ');
    throw new ValidationError(`Net pay is negative for ${names}. Fix their deductions before approving`);
  }
  // Salary, leave or loans may have changed since the draft was computed.
  // Recompute in a savepoint, compare, and roll it back: approval only ever
  // freezes the figures someone actually reviewed.
  const stale = await draftIsStale(tx, run, slips);
  if (stale) {
    throw new ConflictError(`Salary, leave or loan records changed since the ${label} run was computed (${stale}). Recompute, review, then approve`);
  }
  const loans = await tx
    .select({ amount: payslipLines.amount, sipId: payslips.sipId, snapshot: payslips.snapshot })
    .from(payslipLines)
    .innerJoin(payslips, eq(payslipLines.payslipId, payslips.id))
    .where(and(eq(payslips.runId, runId), eq(payslipLines.component, 'Loan / advance'), eq(payslipLines.isManual, false)));
  const { end } = monthBounds(run.periodMonth);
  for (const l of loans) {
    const pos = await loanPosition(tx, l.sipId);
    if (l.amount > pos.balance) {
      throw new ValidationError(
        `The loan balance of ${(l.snapshot as PayslipSnapshot).name} is now ${pkr(pos.balance)}, below the ${pkr(l.amount)} deduction. Recompute the run first`,
      );
    }
    await tx.insert(loansAdvances).values({
      sipId: l.sipId,
      entryType: 'deduction',
      amount: -l.amount,
      entryDate: end,
      runId,
      note: `${label} payroll`,
      balanceAfter: pos.balance - l.amount,
      createdBy: actor.userId,
    });
  }
  const [after] = await tx
    .update(payrollRuns)
    .set({ status: 'approved', approvedBy: actor.userId, approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(payrollRuns.id, runId))
    .returning();
  await writeAudit(tx, actor, {
    action: 'approve',
    entity: 'payroll_run',
    entityId: runId,
    summary: `approved the ${label} payroll run`,
    before: { status: run.status },
    after: { status: after.status, payslips: slips.length, loanDeductions: loans.length },
  });
  const totals = await runTotals(tx, [runId]);
  return { run: runOut(after, totals.get(runId)) };
}

/** Marks an approved run as paid and notifies each employee. Call inside db.transaction. */
export async function markRunPaid(tx: DbOrTx, runId: number, actor: PayrollActor): Promise<{ run: RunSummary }> {
  const run = await lockRun(tx, runId);
  if (run.status !== 'approved') throw new ConflictError('Only an approved run can be marked as paid');
  const label = monthLabel(run.periodMonth);
  const [after] = await tx
    .update(payrollRuns)
    .set({ status: 'paid', paidAt: new Date(), updatedAt: new Date() })
    .where(eq(payrollRuns.id, runId))
    .returning();
  await writeAudit(tx, actor, {
    action: 'pay',
    entity: 'payroll_run',
    entityId: runId,
    summary: `marked the ${label} payroll run as paid`,
    before: { status: run.status },
    after: { status: after.status },
  });
  const slips = await tx.select({ id: payslips.id, sipId: payslips.sipId }).from(payslips).where(eq(payslips.runId, runId));
  for (const s of slips) {
    const uid = await userIdForSip(tx, s.sipId);
    if (uid) await notify(tx, [uid], { title: `Your ${label} payslip is ready`, link: `/payroll/payslips/${s.id}` });
  }
  const totals = await runTotals(tx, [runId]);
  return { run: runOut(after, totals.get(runId)) };
}
