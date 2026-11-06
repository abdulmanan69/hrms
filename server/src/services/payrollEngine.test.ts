import { describe, expect, it } from 'vitest';
import { annualTax, computePayslip, type EngineInput, type EngineStructure } from './payrollEngine.js';
import { DEFAULT_SETTINGS, type PayrollSettings } from './settings.js';

function structure(id: number, effectiveFrom: string, parts: Partial<EngineStructure>): EngineStructure {
  const s = {
    id,
    effectiveFrom,
    basicSalary: 0,
    houseRent: 0,
    medicalAllowance: 0,
    petrolAllowance: 0,
    otherAllowance: 0,
    pfApplicable: false,
    eobiApplicable: false,
    whtApplicable: false,
    ...parts,
  };
  return { ...s, grossSalary: s.basicSalary + s.houseRent + s.medicalAllowance + s.petrolAllowance + s.otherAllowance };
}

function input(over: Partial<EngineInput>): EngineInput {
  return {
    month: '2026-07',
    dateOfJoining: '2025-01-01',
    structures: [],
    unpaidDays: 0,
    settings: DEFAULT_SETTINGS.payroll,
    weekendDays: [0, 6],
    holidays: [],
    loan: null,
    manualLines: [],
    ...over,
  };
}

const sum = (xs: Array<{ amount: number }>) => xs.reduce((n, l) => n + l.amount, 0);

describe('payroll engine', () => {
  it('reproduces the design worked example: 50,000 to 60,000 from 16 July', () => {
    // PF 10% of an earned basic of 30,000 = 3,000; one flat slab gives WHT 1,200 a month.
    const settings: PayrollSettings = {
      pfPercentOfBasic: 10,
      eobiEmployeeAmount: 370,
      whtSlabs: [
        { from: 0, to: 600_000, fixed: 0, rate: 0 },
        { from: 600_000, to: null, fixed: 14_400, rate: 0 },
      ],
      prorationBasis: 'calendar',
    };
    const flags = { pfApplicable: true, eobiApplicable: true, whtApplicable: true };
    const r = computePayslip(
      input({
        settings,
        structures: [
          structure(1, '2025-01-01', { basicSalary: 30_000, houseRent: 15_000, medicalAllowance: 5_000, ...flags }),
          structure(2, '2026-07-16', { basicSalary: 30_000, houseRent: 20_000, medicalAllowance: 5_000, petrolAllowance: 5_000, ...flags }),
        ],
        loan: { balance: 10_000, installment: 2_000 },
        manualLines: [
          { section: 'B', component: 'Overtime', amount: 3_000 },
          { section: 'B', component: 'Incentive', amount: 5_000 },
        ],
      }),
    );

    expect(r.daysOfMonth).toBe(31);
    expect(r.periods.map((p) => [p.from, p.to, p.monthlyGross, p.paidDays])).toEqual([
      ['2026-07-01', '2026-07-15', 50_000, 15],
      ['2026-07-16', '2026-07-31', 60_000, 16],
    ]);
    expect(r.currentSalaryDays).toBe(15);
    expect(r.newSalaryDays).toBe(16);
    expect(r.grossA).toBe(55_161);
    expect(r.totalB).toBe(8_000);
    const c = Object.fromEntries(r.lines.filter((l) => l.section === 'C').map((l) => [l.component, l.amount]));
    expect(c).toEqual({ 'Provident fund': 3_000, EOBI: 370, 'Withholding tax': 1_200, 'Loan / advance': 2_000 });
    expect(r.totalC).toBe(6_570);
    expect(r.net).toBe(56_591);
    // every section reconciles to the rupee
    expect(sum(r.lines.filter((l) => l.section === 'A'))).toBe(r.grossA);
    expect(sum(r.lines.filter((l) => l.section === 'B'))).toBe(r.totalB);
    expect(r.grossA + r.totalB - r.totalC).toBe(r.net);
  });

  it('pays someone who left mid-month up to their last working day', () => {
    const r = computePayslip(
      input({
        month: '2026-11',
        dateOfJoining: '2024-01-01',
        lastWorkingDay: '2026-11-15',
        structures: [structure(1, '2024-01-01', { basicSalary: 60_000, houseRent: 24_000, medicalAllowance: 6_000 })],
      }),
    );
    expect(r.periods[0].paidDays).toBe(15);
    expect(r.grossA).toBe(45_000); // 90,000 / 30 × 15
    expect(r.warnings.some((w) => w.includes('Left on 2026-11-15'))).toBe(true);
  });

  it('pays a mid-month joiner only from the joining date', () => {
    const r = computePayslip(
      input({
        month: '2026-11',
        dateOfJoining: '2026-11-11',
        structures: [structure(1, '2026-11-11', { basicSalary: 60_000, houseRent: 24_000, medicalAllowance: 6_000 })],
      }),
    );
    expect(r.daysOfMonth).toBe(30);
    // Nov 1–10 are before joining, even though the structure itself starts on the joining date
    expect(r.notJoinedDays).toBe(10);
    expect(r.periods[0].paidDays).toBe(20);
    expect(r.grossA).toBe(60_000); // 90,000 / 30 × 20
    expect(sum(r.lines.filter((l) => l.section === 'A'))).toBe(60_000);
  });

  it('counts days before joining as not joined when the structure starts earlier', () => {
    const r = computePayslip(
      input({
        month: '2026-11',
        dateOfJoining: '2026-11-21',
        structures: [structure(1, '2026-11-01', { basicSalary: 30_000 })],
      }),
    );
    expect(r.notJoinedDays).toBe(20);
    expect(r.currentSalaryDays).toBe(10);
    expect(r.grossA).toBe(10_000);
  });

  it('takes unpaid days from the end of the month: the increment period first', () => {
    const r = computePayslip(
      input({
        structures: [
          structure(1, '2025-01-01', { basicSalary: 31_000 }),
          structure(2, '2026-07-16', { basicSalary: 62_000 }),
        ],
        unpaidDays: 4,
      }),
    );
    expect(r.unpaidDays).toBe(4);
    expect(r.periods[0].unpaid).toBe(0);
    expect(r.periods[1].unpaid).toBe(4);
    expect(r.currentSalaryDays).toBe(15);
    expect(r.newSalaryDays).toBe(12);
    expect(r.grossA).toBe(15 * 1_000 + 12 * 2_000);
  });

  it('spills unpaid days into the earlier period and allows half days', () => {
    const r = computePayslip(
      input({
        structures: [
          structure(1, '2025-01-01', { basicSalary: 31_000 }),
          structure(2, '2026-07-30', { basicSalary: 62_000 }),
        ],
        unpaidDays: 3.5,
      }),
    );
    // 30–31 Jul has 2 payable days; the other 1.5 come off the old rate
    expect(r.periods[1].unpaid).toBe(2);
    expect(r.periods[0].unpaid).toBe(1.5);
    expect(r.grossA).toBe(27_500);
  });

  it('places unpaid days by date when per-date data is given', () => {
    const r = computePayslip(
      input({
        structures: [
          structure(1, '2025-01-01', { basicSalary: 31_000 }),
          structure(2, '2026-07-16', { basicSalary: 62_000 }),
        ],
        unpaidDays: 0,
        unpaidDates: [
          { date: '2026-07-07', days: 1 },
          { date: '2026-07-08', days: 0.5 },
          { date: '2026-07-31', days: 1 },
        ],
      }),
    );
    expect(r.periods[0].unpaid).toBe(1.5);
    expect(r.periods[1].unpaid).toBe(1);
    expect(r.grossA).toBe(13.5 * 1_000 + 15 * 2_000);
  });

  it('prorates on working days when configured', () => {
    const r = computePayslip(
      input({
        settings: { ...DEFAULT_SETTINGS.payroll, prorationBasis: 'working' },
        month: '2026-11',
        dateOfJoining: '2026-11-16',
        structures: [structure(1, '2026-01-01', { basicSalary: 42_000 })],
      }),
    );
    // November 2026: 21 working days (Mon–Fri); 16–30 Nov has 11
    expect(r.daysOfMonth).toBe(21);
    expect(r.currentSalaryDays).toBe(11);
    expect(r.grossA).toBe(22_000);
  });

  it('never deducts more loan than the balance and keeps net from going negative', () => {
    const r = computePayslip(
      input({
        structures: [structure(1, '2025-01-01', { basicSalary: 31_000 })],
        loan: { balance: 1_500, installment: 5_000 },
      }),
    );
    expect(r.lines.find((l) => l.component === 'Loan / advance')?.amount).toBe(1_500);

    const r2 = computePayslip(
      input({
        structures: [structure(1, '2025-01-01', { basicSalary: 31_000 })],
        loan: { balance: 100_000, installment: 50_000 },
      }),
    );
    expect(r2.lines.find((l) => l.component === 'Loan / advance')?.amount).toBe(31_000);
    expect(r2.net).toBe(0);
    expect(r2.warnings.length).toBe(1);
  });

  it('applies the default withholding slabs', () => {
    expect(annualTax(600_000, DEFAULT_SETTINGS.payroll.whtSlabs)).toBe(0);
    expect(annualTax(1_200_000, DEFAULT_SETTINGS.payroll.whtSlabs)).toBe(6_000);
    expect(annualTax(2_200_000, DEFAULT_SETTINGS.payroll.whtSlabs)).toBe(116_000);
  });
});
