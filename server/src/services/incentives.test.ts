import { describe, expect, it } from 'vitest';
import { computeIncentive } from './incentives.js';
import { computePayslip } from './payrollEngine.js';
import { DEFAULT_SETTINGS } from './settings.js';

const slabs = [
  { from: 1, rate: 300 },
  { from: 10, rate: 500 },
  { from: 20, rate: 800 },
];

describe('sales incentive', () => {
  it('reached: every sale at the rate of the highest slab reached', () => {
    const r = computeIncentive(12, { mode: 'reached', slabs });
    expect(r.amount).toBe(12 * 500);
    expect(r.slab).toEqual({ from: 10, rate: 500 });
    expect(r.toNext).toBe(8);
  });

  it('stepped: each sale at its own slab', () => {
    const r = computeIncentive(23, { mode: 'stepped', slabs });
    expect(r.amount).toBe(9 * 300 + 10 * 500 + 4 * 800);
    expect(r.steps.map((s) => s.count)).toEqual([9, 10, 4]);
    expect(r.toNext).toBeNull();
  });

  it('nothing below the target (first slab)', () => {
    const plan = { mode: 'stepped' as const, slabs: [{ from: 5, rate: 400 }] };
    expect(computeIncentive(4, plan)).toMatchObject({ amount: 0, slab: null, toNext: 1 });
    expect(computeIncentive(7, plan).amount).toBe(3 * 400);
  });

  it('no slabs, no incentive; slab order does not matter', () => {
    expect(computeIncentive(50, { mode: 'reached', slabs: [] }).amount).toBe(0);
    expect(computeIncentive(12, { mode: 'reached', slabs: [...slabs].reverse() }).amount).toBe(6000);
  });

  it('is paid in section B and counts toward withholding tax', () => {
    const base = {
      month: '2026-11',
      dateOfJoining: '2025-01-01',
      structures: [
        { id: 1, effectiveFrom: '2025-01-01', basicSalary: 60000, houseRent: 0, medicalAllowance: 0, petrolAllowance: 0, otherAllowance: 0, grossSalary: 60000, pfApplicable: false, eobiApplicable: false, whtApplicable: true },
      ],
      unpaidDays: 0,
      settings: DEFAULT_SETTINGS.payroll,
      weekendDays: [0, 6],
      holidays: [],
      loan: null,
      manualLines: [],
    };
    const without = computePayslip(base);
    const withSales = computePayslip({ ...base, autoAdditions: [{ component: 'Sales incentive', amount: 6000 }] });
    expect(withSales.totalB).toBe(6000);
    expect(withSales.lines.find((l) => l.component === 'Sales incentive')).toMatchObject({ section: 'B', isManual: false });
    const tax = (r: typeof without) => r.lines.find((l) => l.component === 'Withholding tax')?.amount ?? 0;
    expect(tax(withSales)).toBeGreaterThan(tax(without));
    expect(withSales.net).toBe(60000 + 6000 - tax(withSales));
  });
});
