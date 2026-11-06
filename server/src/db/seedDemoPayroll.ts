/**
 * Demo payroll history: one run per month for the last 12 months through the
 * real payroll service. Past months are approved and paid; the current month
 * stays in draft. A share of payslips gets overtime and incentive lines (B),
 * entered the way payroll staff would, then recomputed.
 */
import { eq, sql } from 'drizzle-orm';
import { todayISO } from '../lib/dates.js';
import { approveRun, computeRun, createRun, markRunPaid } from '../services/payrollService.js';
import { db } from './client.js';
import { payrollRuns, payslipLines, payslips } from './schema.js';

function monthsBack(fromMonth: string, n: number): string[] {
  const [y, m] = fromMonth.split('-').map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export async function seedDemoPayroll(monthCount = 12): Promise<void> {
  const current = todayISO().slice(0, 7);
  const months = monthsBack(current, monthCount);
  const actor = { userId: null };

  await db.transaction(async (tx) => {
    for (const [mi, month] of months.entries()) {
      const { run } = await createRun(tx, month, actor);
      const slips = await tx.select({ id: payslips.id, sipId: payslips.sipId }).from(payslips).where(eq(payslips.runId, run.id));
      if (slips.length === 0) continue;

      // additions on roughly a third of payslips, a little more each month
      const lines: Array<typeof payslipLines.$inferInsert> = [];
      for (const [i, s] of slips.entries()) {
        const k = (i * 7 + mi * 3) % 10;
        if (k < 3) lines.push({ payslipId: s.id, section: 'B', component: 'Overtime', amount: 2_000 + ((i * 1_300 + mi * 700) % 6_000), isManual: true, sortOrder: 100 });
        if (k === 4 || k === 7) lines.push({ payslipId: s.id, section: 'B', component: 'Incentive', amount: 5_000 + ((i * 2_500 + mi * 1_000) % 10_000), isManual: true, sortOrder: 101 });
        if (k === 9 && i % 2 === 0) lines.push({ payslipId: s.id, section: 'B', component: 'Internet / mobile', amount: 2_000, isManual: true, sortOrder: 102 });
      }
      if (lines.length) await tx.insert(payslipLines).values(lines);

      const [row] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, run.id));
      await computeRun(tx, row);

      if (month < current) {
        await approveRun(tx, run.id, actor);
        await markRunPaid(tx, run.id, actor);
        // back-date the run so history reads naturally
        const paid = new Date(`${month}-28T12:00:00Z`);
        await tx.update(payrollRuns).set({ approvedAt: paid, paidAt: paid, createdAt: paid }).where(eq(payrollRuns.id, run.id));
      }
    }
    // the demo employee keeps only the latest "payslip ready" notice unread
    await tx.execute(
      sql`update notifications set read_at = now() where read_at is null and id not in (select max(id) from notifications group by user_id)`,
    );
  });
  console.log(`Demo payroll: ${months.length} runs`);
}
