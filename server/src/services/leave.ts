/**
 * Leave applications: day counting, the paid/unpaid split, and the state
 * changes (submit, approve, reject, cancel) with their ledger effects.
 *
 * The rule for `unpaid_days` (what payroll uses to reduce pay):
 * - unpaid type: every day of the application is unpaid;
 * - paid type: the days covered by the balance are paid, the rest unpaid.
 *   Only whole and half days can be covered, so a balance of 2.83 covers 2.5.
 * At submission the split is a projection against the balance left after
 * the employee's other pending applications of the same type. On approval it
 * is recomputed against the balance at that moment (under the ledger lock),
 * stored on the application, and the paid part is written to the ledger.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { DbOrTx } from '../db/client.js';
import { employees, leaveApplications, leaveLedger, leaveTypes, type LeaveStatus } from '../db/schema.js';
import { can, isInTeam } from '../auth/plugin.js';
import type { AuthContext } from '../auth/session.js';
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from '../lib/errors.js';
import { eachDay, todayISO, weekday } from '../lib/dates.js';
import { notify, writeAudit } from '../lib/audit.js';
import { appendLedger, balanceOf } from './leaveLedger.js';
import { fullName, managerUserIdForSip, userIdForSip, userIdsWithPermission } from './people.js';
import { getSetting, type LeaveSettings } from './settings.js';

export const APPLICATION_REF = (id: number) => `leave_application:${id}`;
export const REVERSAL_REF = (id: number) => `leave_application:${id}:cancelled`;

/* ------------------------------------------------------------------ */
/* Day counting                                                         */
/* ------------------------------------------------------------------ */

/** Working days in [from, to], skipping weekend days and public holidays. */
export function workingDates(from: string, to: string, s: LeaveSettings): string[] {
  const off = new Set(s.holidays);
  return eachDay(from, to).filter((d) => !s.weekendDays.includes(weekday(d)) && !off.has(d));
}

/** Total leave days for a range; a half day only applies to a single working day. */
export function countLeaveDays(from: string, to: string, halfDay: boolean, s: LeaveSettings): number {
  if (to < from) throw new ValidationError('End date is before the start date');
  if (halfDay && from !== to) throw new ValidationError('A half day must start and end on the same date');
  const n = workingDates(from, to, s).length;
  if (n === 0) throw new ValidationError('These dates fall on weekends or public holidays: no leave days to take');
  return halfDay ? 0.5 : n;
}

/** Largest whole-or-half number of days a balance can cover (never negative). */
export function coverable(balance: number): number {
  return Math.max(0, Math.floor(balance * 2 + 1e-9) / 2);
}

/** Paid/unpaid split of `total` days against an available balance. */
export function splitDays(total: number, isPaid: boolean, available: number): { paidDays: number; unpaidDays: number } {
  if (!isPaid) return { paidDays: 0, unpaidDays: total };
  const paidDays = Math.min(total, coverable(available));
  return { paidDays, unpaidDays: round2(total - paidDays) };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "1 day", "0.5 day", "3 days" */
export function daysPhrase(n: number): string {
  return `${n} day${n === 1 || n === 0.5 ? '' : 's'}`;
}

function typePhrase(name: string): string {
  return `${name.toLowerCase()} leave`;
}

/* ------------------------------------------------------------------ */
/* Access                                                               */
/* ------------------------------------------------------------------ */

/** leave.view, leave.approve and leave.manage see everyone; leave.approve.team sees direct reports. */
export function seesAllLeave(auth: AuthContext): boolean {
  return can(auth, 'leave.view') || can(auth, 'leave.approve') || can(auth, 'leave.manage');
}

/** May the signed-in user read this employee's leave (balances, ledger, applications, attachments)? */
export async function canReadLeave(auth: AuthContext, sipId: string): Promise<boolean> {
  if (auth.sipId === sipId) return true;
  if (seesAllLeave(auth)) return true;
  if (can(auth, 'leave.approve.team') || can(auth, 'team.view')) return isInTeam(auth, sipId);
  return false;
}

export async function assertCanReadLeave(auth: AuthContext, sipId: string): Promise<void> {
  if (!(await canReadLeave(auth, sipId))) throw new ForbiddenError("You cannot view this employee's leave");
}

/** Approve/reject rights for one application's employee. Nobody decides their own leave. */
export async function canDecideFor(auth: AuthContext, sipId: string): Promise<boolean> {
  if (auth.sipId === sipId) return false;
  if (can(auth, 'leave.approve')) return true;
  if (can(auth, 'leave.approve.team')) return isInTeam(auth, sipId);
  return false;
}

/** Sync variant for list rows that already carry the employee's manager. */
export function canDecideRow(auth: AuthContext, row: { sipId: string; managerSipId: string | null; status: LeaveStatus }): boolean {
  if (row.status !== 'pending' || auth.sipId === row.sipId) return false;
  if (can(auth, 'leave.approve')) return true;
  return can(auth, 'leave.approve.team') && !!auth.sipId && row.managerSipId === auth.sipId;
}

export function canCancelRow(auth: AuthContext, row: { sipId: string; status: LeaveStatus; startDate: string }, today = todayISO()): boolean {
  if (auth.sipId !== row.sipId && !can(auth, 'leave.manage')) return false;
  return row.status === 'pending' || (row.status === 'approved' && row.startDate > today);
}

/* ------------------------------------------------------------------ */
/* Projection                                                           */
/* ------------------------------------------------------------------ */

/** Paid days held by the employee's other pending applications of this type. */
async function pendingPaidDays(tx: DbOrTx, sipId: string, leaveTypeId: number, excludeId?: number): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(${leaveApplications.totalDays} - ${leaveApplications.unpaidDays}), 0)::float8` })
    .from(leaveApplications)
    .where(
      and(
        eq(leaveApplications.sipId, sipId),
        eq(leaveApplications.leaveTypeId, leaveTypeId),
        eq(leaveApplications.status, 'pending'),
        excludeId ? ne(leaveApplications.id, excludeId) : undefined,
      ),
    );
  return Number(row?.n ?? 0);
}

export interface Quote {
  totalDays: number;
  workingDates: string[];
  isPaid: boolean;
  /** current ledger balance (null for unpaid types) */
  balance: number | null;
  /** paid days already held by other pending applications of this type */
  pendingDays: number;
  paidDays: number;
  unpaidDays: number;
  /** balance once this and the other pending applications are approved */
  balanceAfter: number | null;
  requiresAttachment: boolean;
  overlaps: Array<{ id: number; startDate: string; endDate: string; status: LeaveStatus }>;
}

export async function quote(
  tx: DbOrTx,
  input: { sipId: string; leaveTypeId: number; startDate: string; endDate: string; halfDay: boolean },
): Promise<Quote> {
  const type = await activeType(tx, input.leaveTypeId);
  const settings = await getSetting(tx, 'leave');
  const totalDays = countLeaveDays(input.startDate, input.endDate, input.halfDay, settings);
  const overlaps = await overlapping(tx, input.sipId, input.startDate, input.endDate);
  if (!type.isPaid) {
    return {
      totalDays,
      workingDates: workingDates(input.startDate, input.endDate, settings),
      isPaid: false,
      balance: null,
      pendingDays: 0,
      paidDays: 0,
      unpaidDays: totalDays,
      balanceAfter: null,
      requiresAttachment: type.requiresAttachment,
      overlaps,
    };
  }
  const balance = await balanceOf(tx, input.sipId, type.id);
  const pendingDays = await pendingPaidDays(tx, input.sipId, type.id);
  const split = splitDays(totalDays, true, balance - pendingDays);
  return {
    totalDays,
    workingDates: workingDates(input.startDate, input.endDate, settings),
    isPaid: true,
    balance,
    pendingDays,
    ...split,
    balanceAfter: round2(balance - pendingDays - split.paidDays),
    requiresAttachment: type.requiresAttachment,
    overlaps,
  };
}

async function activeType(tx: DbOrTx, id: number) {
  const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, id));
  if (!type) throw new NotFoundError('Leave type not found');
  if (!type.active) throw new ValidationError(`${type.name} leave is no longer offered`);
  return type;
}

async function overlapping(tx: DbOrTx, sipId: string, from: string, to: string, excludeId?: number) {
  return tx
    .select({ id: leaveApplications.id, startDate: leaveApplications.startDate, endDate: leaveApplications.endDate, status: leaveApplications.status })
    .from(leaveApplications)
    .where(
      and(
        eq(leaveApplications.sipId, sipId),
        inArray(leaveApplications.status, ['pending', 'approved']),
        sql`${leaveApplications.startDate} <= ${to} and ${leaveApplications.endDate} >= ${from}`,
        excludeId ? ne(leaveApplications.id, excludeId) : undefined,
      ),
    );
}

/* ------------------------------------------------------------------ */
/* State changes                                                        */
/* ------------------------------------------------------------------ */

export interface SubmitInput {
  sipId: string;
  leaveTypeId: number;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  reason?: string | null;
  attachment?: { storedName: string; fileName: string } | null;
}

export async function submitApplication(tx: DbOrTx, req: FastifyRequest, input: SubmitInput) {
  const [emp] = await tx.select().from(employees).where(eq(employees.sipId, input.sipId));
  if (!emp) throw new NotFoundError('Employee not found');
  if (emp.status === 'inactive') throw new ValidationError(`${fullName(emp)} is inactive and cannot apply for leave`);

  const type = await activeType(tx, input.leaveTypeId);
  if (type.requiresAttachment && !input.attachment) {
    throw new ValidationError(`${type.name} leave needs an attachment, such as a medical note`);
  }
  // serialise this employee's submissions so two overlapping requests can't both pass the check
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'leave_apply:' + input.sipId}))`);
  const q = await quote(tx, input);
  if (q.overlaps.length > 0) {
    const o = q.overlaps[0];
    throw new ConflictError(`Overlaps ${o.status} leave from ${o.startDate} to ${o.endDate}`);
  }

  const [row] = await tx
    .insert(leaveApplications)
    .values({
      sipId: input.sipId,
      leaveTypeId: type.id,
      startDate: input.startDate,
      endDate: input.endDate,
      totalDays: q.totalDays,
      unpaidDays: q.unpaidDays,
      halfDay: input.halfDay,
      reason: input.reason?.trim() || null,
      attachmentName: input.attachment?.fileName ?? null,
      attachmentStored: input.attachment?.storedName ?? null,
      status: 'pending',
      createdBy: req.auth.userId,
    })
    .returning();

  const name = fullName(emp);
  const self = req.auth.sipId === input.sipId;
  const what = `${daysPhrase(q.totalDays)} of ${typePhrase(type.name)}`;
  await writeAudit(tx, req, {
    action: 'create',
    entity: 'leave_application',
    entityId: row.id,
    summary: self ? `applied for ${what}` : `applied for ${what} for ${name}`,
    after: row,
  });

  const manager = await managerUserIdForSip(tx, input.sipId);
  const approvers = manager ? [manager] : await userIdsWithPermission(tx, 'leave.approve');
  const unpaidNote = q.unpaidDays > 0 ? `, ${daysPhrase(q.unpaidDays)} unpaid` : '';
  await notify(
    tx,
    approvers.filter((id) => id !== req.auth.userId),
    {
      title: `${name} applied for ${what}`,
      body: `${input.startDate} to ${input.endDate}${unpaidNote}`,
      link: '/leave/requests',
    },
  );
  if (!self) {
    const applicant = await userIdForSip(tx, input.sipId);
    await notify(tx, [applicant].filter((id) => id !== req.auth.userId), {
      title: `${req.auth.name} applied for ${what} for you`,
      body: `${input.startDate} to ${input.endDate}`,
      link: '/me/leave',
    });
  }
  return row;
}

async function lockApplication(tx: DbOrTx, id: number) {
  const [row] = await tx.select().from(leaveApplications).where(eq(leaveApplications.id, id)).for('update');
  if (!row) throw new NotFoundError('Leave application not found');
  const [emp] = await tx.select().from(employees).where(eq(employees.sipId, row.sipId));
  const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, row.leaveTypeId));
  return { app: row, emp, type };
}

export async function decideApplication(
  tx: DbOrTx,
  req: FastifyRequest,
  id: number,
  decision: 'approved' | 'rejected',
  comment: string | null,
) {
  const { app, emp, type } = await lockApplication(tx, id);
  if (app.sipId === req.auth.sipId) throw new ForbiddenError('You cannot decide your own leave');
  if (!(await canDecideFor(req.auth, app.sipId))) {
    throw new ForbiddenError(can(req.auth, 'leave.approve.team') ? 'You can only decide leave for your direct reports' : 'You do not have permission to approve leave');
  }
  if (app.status !== 'pending') throw new ConflictError(`This application is already ${app.status}`);

  let unpaidDays = app.unpaidDays;
  let ledgerRow: typeof leaveLedger.$inferSelect | null = null;
  if (decision === 'approved') {
    if (type.isPaid) {
      // hold the ledger lock for (employee, type) while reading the balance and writing the entry
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${app.sipId}), ${app.leaveTypeId})`);
      const balance = await balanceOf(tx, app.sipId, app.leaveTypeId);
      const split = splitDays(app.totalDays, true, balance);
      unpaidDays = split.unpaidDays;
      if (split.paidDays > 0) {
        ledgerRow = await appendLedger(tx, {
          sipId: app.sipId,
          leaveTypeId: app.leaveTypeId,
          entryType: 'application',
          days: -split.paidDays,
          entryDate: todayISO(),
          reference: APPLICATION_REF(app.id),
          note: `${type.name} leave ${app.startDate} to ${app.endDate}${split.unpaidDays > 0 ? `, ${daysPhrase(split.unpaidDays)} unpaid` : ''}`,
          createdBy: req.auth.userId,
        });
      }
    } else {
      unpaidDays = app.totalDays;
    }
  }

  const [after] = await tx
    .update(leaveApplications)
    .set({ status: decision, unpaidDays, approverId: req.auth.userId, decisionComment: comment?.trim() || null, decidedAt: new Date() })
    .where(eq(leaveApplications.id, id))
    .returning();

  const name = fullName(emp);
  const what = `${daysPhrase(app.totalDays)} of ${typePhrase(type.name)}`;
  const verb = decision === 'approved' ? 'approved' : 'rejected';
  const unpaidNote = decision === 'approved' && unpaidDays > 0 ? ` (${daysPhrase(unpaidDays)} unpaid)` : '';
  await writeAudit(tx, req, {
    action: decision === 'approved' ? 'approve' : 'reject',
    entity: 'leave_application',
    entityId: id,
    summary: `${verb} ${what} for ${name}${unpaidNote}`,
    before: app,
    after: { ...after, ledgerEntryId: ledgerRow?.id ?? null },
  });
  const applicant = await userIdForSip(tx, app.sipId);
  await notify(tx, [applicant], {
    title: `Your ${typePhrase(type.name)} was ${verb}`,
    body: [`${app.startDate} to ${app.endDate}${unpaidNote}`, comment?.trim()].filter(Boolean).join('. '),
    link: '/me/leave',
  });
  return after;
}

export async function cancelApplication(tx: DbOrTx, req: FastifyRequest, id: number, comment: string | null) {
  const { app, emp, type } = await lockApplication(tx, id);
  const self = app.sipId === req.auth.sipId;
  if (!self && !can(req.auth, 'leave.manage')) throw new ForbiddenError('Only the applicant or HR can cancel leave');
  const today = todayISO();
  if (app.status !== 'pending' && app.status !== 'approved') throw new ConflictError(`This application is already ${app.status}`);
  if (app.status === 'approved' && app.startDate <= today) {
    throw new ValidationError('Leave that has already started cannot be cancelled. HR can correct the balance with an adjustment');
  }

  let reversal: typeof leaveLedger.$inferSelect | null = null;
  if (app.status === 'approved' && type.isPaid) {
    const [entry] = await tx
      .select()
      .from(leaveLedger)
      .where(and(eq(leaveLedger.sipId, app.sipId), eq(leaveLedger.leaveTypeId, app.leaveTypeId), eq(leaveLedger.reference, APPLICATION_REF(app.id))));
    if (entry && entry.days < 0) {
      reversal = await appendLedger(tx, {
        sipId: app.sipId,
        leaveTypeId: app.leaveTypeId,
        entryType: 'reversal',
        days: -entry.days,
        entryDate: today,
        reference: REVERSAL_REF(app.id),
        note: `Cancelled ${type.name.toLowerCase()} leave ${app.startDate} to ${app.endDate}`,
        createdBy: req.auth.userId,
      });
    }
  }

  const [after] = await tx
    .update(leaveApplications)
    .set({
      status: 'cancelled',
      decisionComment: comment?.trim() || app.decisionComment,
      decidedAt: app.decidedAt ?? new Date(),
      approverId: app.approverId ?? req.auth.userId,
    })
    .where(eq(leaveApplications.id, id))
    .returning();

  const name = fullName(emp);
  const what = `${daysPhrase(app.totalDays)} of ${typePhrase(type.name)}`;
  await writeAudit(tx, req, {
    action: 'cancel',
    entity: 'leave_application',
    entityId: id,
    summary: self ? `cancelled their ${what}` : `cancelled ${what} for ${name}`,
    before: app,
    after: { ...after, reversalEntryId: reversal?.id ?? null },
  });
  if (!self) {
    const applicant = await userIdForSip(tx, app.sipId);
    await notify(tx, [applicant], { title: `Your ${typePhrase(type.name)} was cancelled`, body: `${app.startDate} to ${app.endDate}`, link: '/me/leave' });
  } else if (app.status === 'approved' && app.approverId && app.approverId !== req.auth.userId) {
    await notify(tx, [app.approverId], { title: `${name} cancelled approved ${typePhrase(type.name)}`, body: `${app.startDate} to ${app.endDate}`, link: '/leave/requests' });
  }
  return after;
}

/* ------------------------------------------------------------------ */
/* Balances                                                             */
/* ------------------------------------------------------------------ */

/** Latest balance per (employee, type) for many employees in one query. Key: `${sipId}:${typeId}`. */
export async function latestBalances(tx: DbOrTx, sipIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (sipIds.length === 0) return out;
  const rows = await tx
    .selectDistinctOn([leaveLedger.sipId, leaveLedger.leaveTypeId], {
      sipId: leaveLedger.sipId,
      leaveTypeId: leaveLedger.leaveTypeId,
      balance: leaveLedger.balanceAfter,
    })
    .from(leaveLedger)
    .where(inArray(leaveLedger.sipId, sipIds))
    .orderBy(leaveLedger.sipId, leaveLedger.leaveTypeId, desc(leaveLedger.id));
  for (const r of rows) out.set(`${r.sipId}:${r.leaveTypeId}`, r.balance);
  return out;
}
