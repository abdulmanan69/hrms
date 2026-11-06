/**
 * Leave balance is a ledger, not a number. Every grant, application and
 * adjustment is a dated row; the balance is their running sum, kept in
 * balance_after on each row for quick display.
 *
 * Shared by the Leave module (applications, adjustments), Employees (initial
 * grant on hire) and the daily accrual job (index.ts).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { employees, leaveLedger, leaveTypes, type LedgerEntryType } from '../db/schema.js';
import { monthOf } from '../lib/dates.js';

export interface LedgerInput {
  sipId: string;
  leaveTypeId: number;
  entryType: LedgerEntryType;
  /** signed: + grant, − taken */
  days: number;
  entryDate: string;
  /** unique per (sip, type); a second entry with the same reference is skipped */
  reference?: string | null;
  note?: string | null;
  createdBy?: number | null;
}

/** Current balance for one employee and leave type. */
export async function balanceOf(tx: DbOrTx, sipId: string, leaveTypeId: number): Promise<number> {
  const [last] = await tx
    .select({ balance: leaveLedger.balanceAfter })
    .from(leaveLedger)
    .where(and(eq(leaveLedger.sipId, sipId), eq(leaveLedger.leaveTypeId, leaveTypeId)))
    .orderBy(desc(leaveLedger.id))
    .limit(1);
  return last?.balance ?? 0;
}

/**
 * Appends one ledger row with its running balance. Serialised per
 * (employee, leave type) with an advisory lock so concurrent writes never
 * compute the same balance_after. Returns null when `reference` already exists.
 */
export async function appendLedger(tx: DbOrTx, e: LedgerInput): Promise<typeof leaveLedger.$inferSelect | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${e.sipId}), ${e.leaveTypeId})`);
  if (e.reference) {
    const [dupe] = await tx
      .select({ id: leaveLedger.id })
      .from(leaveLedger)
      .where(and(eq(leaveLedger.sipId, e.sipId), eq(leaveLedger.leaveTypeId, e.leaveTypeId), eq(leaveLedger.reference, e.reference)));
    if (dupe) return null;
  }
  const before = await balanceOf(tx, e.sipId, e.leaveTypeId);
  const balanceAfter = Math.round((before + e.days) * 100) / 100;
  const [row] = await tx
    .insert(leaveLedger)
    .values({
      sipId: e.sipId,
      leaveTypeId: e.leaveTypeId,
      entryType: e.entryType,
      days: e.days,
      entryDate: e.entryDate,
      reference: e.reference ?? null,
      note: e.note ?? null,
      balanceAfter,
      createdBy: e.createdBy ?? null,
    })
    .returning();
  return row;
}

/** Balances per leave type for one employee (active types only, paid types first). */
export async function balancesFor(tx: DbOrTx, sipId: string) {
  const types = await tx.select().from(leaveTypes).where(eq(leaveTypes.active, true)).orderBy(leaveTypes.sortOrder, leaveTypes.name);
  const out = [];
  for (const t of types) {
    out.push({
      leaveTypeId: t.id,
      name: t.name,
      isPaid: t.isPaid,
      entitlement: t.annualEntitlementDays,
      balance: t.isPaid ? await balanceOf(tx, sipId, t.id) : null,
    });
  }
  return out;
}

/** Half-day rounding for prorated grants. */
function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

/**
 * Grants what an employee is owed up to `asOf`, idempotently:
 * - annual types: the year's entitlement once per year (prorated by months
 *   left in the joining year), after expiring last year's balance above the
 *   carry-forward limit;
 * - monthly types: entitlement ÷ 12 for each month since joining (or Jan 1).
 * Safe to call any number of times: every grant carries a unique reference.
 */
export async function accrueFor(
  tx: DbOrTx,
  emp: { sipId: string; dateOfJoining: string },
  asOf: string,
  createdBy: number | null = null,
): Promise<number> {
  if (emp.dateOfJoining > asOf) return 0;
  const types = await tx.select().from(leaveTypes).where(and(eq(leaveTypes.active, true), eq(leaveTypes.isPaid, true)));
  const year = Number(asOf.slice(0, 4));
  const joinYear = Number(emp.dateOfJoining.slice(0, 4));
  let written = 0;

  for (const t of types) {
    if (t.accrualRule === 'none' || t.annualEntitlementDays <= 0) continue;

    if (t.accrualRule === 'annual') {
      // carry forward: expire what exceeds the limit before the new year's grant
      if (year > joinYear) {
        // balance at the end of last year only: this year's grant must never be expired
        const [{ bal }] = await tx
          .select({ bal: sql<number>`coalesce(sum(${leaveLedger.days}), 0)::float8` })
          .from(leaveLedger)
          .where(and(eq(leaveLedger.sipId, emp.sipId), eq(leaveLedger.leaveTypeId, t.id), sql`${leaveLedger.entryDate} < ${`${year}-01-01`}`));
        const excess = Number(bal) - t.carryForwardMax;
        if (excess > 0) {
          const r = await appendLedger(tx, {
            sipId: emp.sipId,
            leaveTypeId: t.id,
            entryType: 'carry_forward',
            days: -excess,
            entryDate: `${year}-01-01`,
            reference: `expire:${year - 1}`,
            note: `Expired above the ${t.carryForwardMax}-day carry-forward limit`,
            createdBy,
          });
          if (r) written++;
        }
      }
      // joining year: prorate by whole months remaining, counting the joining month
      const monthsLeft = year === joinYear ? 12 - Number(emp.dateOfJoining.slice(5, 7)) + 1 : 12;
      const days = roundHalf((t.annualEntitlementDays * monthsLeft) / 12);
      if (days > 0) {
        const r = await appendLedger(tx, {
          sipId: emp.sipId,
          leaveTypeId: t.id,
          entryType: 'accrual',
          days,
          entryDate: year === joinYear ? emp.dateOfJoining : `${year}-01-01`,
          reference: `accrual:${year}`,
          note: year === joinYear && monthsLeft < 12 ? `Prorated for ${monthsLeft} months` : `Annual grant ${year}`,
          createdBy,
        });
        if (r) written++;
      }
    } else {
      // monthly: one grant per started month from joining (or Jan of this year) to asOf
      const startMonth = monthOf(emp.dateOfJoining > `${year}-01-01` ? emp.dateOfJoining : `${year}-01-01`);
      const endMonth = monthOf(asOf);
      // cumulative rounding: month k grants round(entitlement × k/12) minus what months 1…k−1 granted,
      // so twelve grants add up to the entitlement exactly (14/12 per month would drift to 14.04)
      const cumulative = (m: string) => Math.round((t.annualEntitlementDays * Number(m.slice(5, 7))) / 12 * 100) / 100;
      for (let m = startMonth; m <= endMonth; m = nextMonth(m)) {
        const prev = Number(m.slice(5, 7)) === 1 ? 0 : cumulative(`${m.slice(0, 4)}-${String(Number(m.slice(5, 7)) - 1).padStart(2, '0')}`);
        const r = await appendLedger(tx, {
          sipId: emp.sipId,
          leaveTypeId: t.id,
          entryType: 'accrual',
          days: Math.round((cumulative(m) - prev) * 100) / 100,
          entryDate: m === monthOf(emp.dateOfJoining) ? emp.dateOfJoining : `${m}-01`,
          reference: `accrual:${m}`,
          note: `Monthly accrual ${m}`,
          createdBy,
        });
        if (r) written++;
      }
    }
  }
  return written;
}

function nextMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/** Daily job: accrue for every active or pending employee. Returns rows written. */
export async function accrueAll(tx: DbOrTx, asOf: string): Promise<number> {
  const staff = await tx
    .select({ sipId: employees.sipId, dateOfJoining: employees.dateOfJoining })
    .from(employees)
    .where(sql`${employees.status} in ('active','pending')`);
  let n = 0;
  for (const e of staff) n += await accrueFor(tx, e, asOf);
  return n;
}
