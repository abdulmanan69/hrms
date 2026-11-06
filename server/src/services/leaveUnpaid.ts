/**
 * The one place Leave and Payroll touch: unpaid leave days per employee per
 * month, from approved applications.
 *
 * An application's `unpaid_days` is a total. When it spans months, the
 * unpaid days are taken from the END of the leave (paid days are used first,
 * as the balance is drawn down day by day), one working day at a time, half a
 * day for a half-day application. Any remainder that the current working-day
 * calendar can't place (holidays changed after approval) falls on the last day.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { leaveApplications } from '../db/schema.js';
import { monthBounds, monthOf } from '../lib/dates.js';
import { getSetting } from './settings.js';
import { round2, workingDates } from './leave.js';

/** Unpaid days in each month for one application: { 'YYYY-MM': days }. */
export function allocateUnpaid(
  app: { startDate: string; endDate: string; unpaidDays: number; halfDay: boolean },
  dates: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  let left = app.unpaidDays;
  if (left <= 0) return out;
  const step = app.halfDay ? 0.5 : 1;
  for (let i = dates.length - 1; i >= 0 && left > 0; i--) {
    const take = Math.min(step, left);
    const m = monthOf(dates[i]);
    out[m] = round2((out[m] ?? 0) + take);
    left = round2(left - take);
  }
  if (left > 0) {
    const m = monthOf(app.endDate);
    out[m] = round2((out[m] ?? 0) + left);
  }
  return out;
}

/**
 * Unpaid leave days in `month` ('YYYY-MM') per SIP ID, from approved
 * applications only. Pass `sipIds` to limit the result.
 */
export async function unpaidDaysByMonth(tx: DbOrTx, month: string, sipIds?: string[]): Promise<Map<string, number>> {
  const { start, end } = monthBounds(month);
  const settings = await getSetting(tx, 'leave');
  const apps = await tx
    .select({
      sipId: leaveApplications.sipId,
      startDate: leaveApplications.startDate,
      endDate: leaveApplications.endDate,
      unpaidDays: leaveApplications.unpaidDays,
      halfDay: leaveApplications.halfDay,
    })
    .from(leaveApplications)
    .where(
      and(
        eq(leaveApplications.status, 'approved'),
        sql`${leaveApplications.unpaidDays} > 0`,
        sql`${leaveApplications.startDate} <= ${end} and ${leaveApplications.endDate} >= ${start}`,
        sipIds && sipIds.length > 0 ? inArray(leaveApplications.sipId, sipIds) : undefined,
      ),
    );
  const out = new Map<string, number>();
  for (const a of apps) {
    const share = allocateUnpaid(a, workingDates(a.startDate, a.endDate, settings))[month] ?? 0;
    if (share > 0) out.set(a.sipId, round2((out.get(a.sipId) ?? 0) + share));
  }
  return out;
}
