/**
 * Database side of sales: monthly counts per person and role, and which
 * months are closed because their payroll is approved or paid.
 */
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { payrollRuns, sales } from '../db/schema.js';
import { monthBounds } from '../lib/dates.js';
import { computeIncentive, ROLE_COMPONENT, SALE_ROLES, type IncentiveResult, type SaleRole } from './incentives.js';
import type { IncentiveSettings } from './settings.js';

export type RoleCounts = Record<SaleRole, number>;

/** Confirmed sales per person and role in a month ('YYYY-MM'). */
export async function salesCounts(tx: DbOrTx, month: string, sipIds?: string[]): Promise<Map<string, RoleCounts>> {
  const out = new Map<string, RoleCounts>();
  if (sipIds && sipIds.length === 0) return out;
  const { start, end } = monthBounds(month);
  const rows = await tx
    .select({ sipId: sales.sipId, role: sales.role, n: sql<number>`count(*)::int` })
    .from(sales)
    .where(
      and(
        eq(sales.status, 'confirmed'),
        gte(sales.saleDate, start),
        lte(sales.saleDate, end),
        sipIds ? inArray(sales.sipId, sipIds) : undefined,
      ),
    )
    .groupBy(sales.sipId, sales.role);
  for (const r of rows) {
    const c = out.get(r.sipId) ?? { closer: 0, fronter: 0 };
    if (r.role === 'closer' || r.role === 'fronter') c[r.role] = r.n;
    out.set(r.sipId, c);
  }
  return out;
}

export interface PersonIncentive {
  closer: IncentiveResult;
  fronter: IncentiveResult;
  total: number;
}

export function incentiveOf(counts: RoleCounts | undefined, plan: IncentiveSettings): PersonIncentive {
  const closer = computeIncentive(counts?.closer ?? 0, plan.closer);
  const fronter = computeIncentive(counts?.fronter ?? 0, plan.fronter);
  return { closer, fronter, total: closer.amount + fronter.amount };
}

/** The payslip lines (section B) for a person's incentive; empty when payroll should not include it. */
export function incentiveAdditions(counts: RoleCounts | undefined, plan: IncentiveSettings) {
  if (!plan.includeInPayroll) return [];
  const p = incentiveOf(counts, plan);
  return SALE_ROLES.filter((r) => p[r].amount > 0).map((r) => ({ component: ROLE_COMPONENT[r], amount: p[r].amount }));
}

/** Months ('YYYY-MM') whose payroll is approved or paid: their sales no longer change. */
export async function closedMonths(tx: DbOrTx): Promise<Set<string>> {
  const rows = await tx
    .select({ month: payrollRuns.periodMonth })
    .from(payrollRuns)
    .where(inArray(payrollRuns.status, ['approved', 'paid']));
  return new Set(rows.map((r) => r.month));
}
