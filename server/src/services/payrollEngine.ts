/**
 * The payroll engine: one employee, one month, no database.
 *
 *   Net = A (gross earned) + B (additions) − C (deductions)
 *
 * A splits the month into rate periods (one per salary_structures row in
 * force during the month) and pays each MonthlySalary_p / DaysOfMonth ×
 * PaidDays_p, where PaidDays_p = Days_p − NotJoined_p − Unpaid_p. A is
 * rounded once; its component lines are rounded individually and the
 * remainder goes on Basic, so every section reconciles to the rupee.
 */
import { addDays, daysBetweenInclusive, monthBounds, workingDaysBetween, type ISODate } from '../lib/dates.js';
import type { PayrollSettings } from './settings.js';

export interface EngineStructure {
  id: number;
  effectiveFrom: ISODate;
  basicSalary: number;
  houseRent: number;
  medicalAllowance: number;
  petrolAllowance: number;
  otherAllowance: number;
  grossSalary: number;
  pfApplicable: boolean;
  eobiApplicable: boolean;
  whtApplicable: boolean;
}

/** Unpaid leave placed on specific days (when a caller has per-date data). */
export interface EngineUnpaidDay {
  date: ISODate;
  days: number;
}

export interface EngineManualLine {
  section: 'B' | 'C';
  component: string;
  amount: number;
}

export interface EngineInput {
  /** 'YYYY-MM' */
  month: string;
  dateOfJoining: ISODate;
  /** set for someone who left: days after it are not paid */
  lastWorkingDay?: ISODate | null;
  structures: EngineStructure[];
  /**
   * Unpaid leave days in this month (from leaveUnpaid.unpaidDaysByMonth). Without
   * per-date data they are taken from the end of the month: the latest rate
   * period first, spilling into earlier periods when it has too few payable days.
   */
  unpaidDays: number;
  /** optional exact placement; when given it replaces `unpaidDays` */
  unpaidDates?: EngineUnpaidDay[];
  settings: PayrollSettings;
  /** used when settings.prorationBasis = 'working' */
  weekendDays: number[];
  holidays: ISODate[];
  /** outstanding loan/advance balance and the monthly installment, if any */
  loan: { balance: number; installment: number } | null;
  manualLines: EngineManualLine[];
  /** computed additions, e.g. the sales incentive; paid in B before manual lines */
  autoAdditions?: Array<{ component: string; amount: number }>;
}

export interface EnginePeriod {
  structureId: number;
  from: ISODate;
  to: ISODate;
  monthlyGross: number;
  /** days in the period on the proration basis */
  days: number;
  notJoined: number;
  unpaid: number;
  paidDays: number;
  /** unrounded amount this period contributes to A */
  amount: number;
}

export interface EngineLine {
  section: 'A' | 'B' | 'C';
  component: string;
  amount: number;
  isManual: boolean;
  sortOrder: number;
}

export interface EngineResult {
  basis: 'calendar' | 'working';
  calendarDays: number;
  workingDays: number;
  /** DaysOfMonth on the chosen basis */
  daysOfMonth: number;
  periods: EnginePeriod[];
  currentSalaryDays: number;
  newSalaryDays: number;
  notJoinedDays: number;
  unpaidDays: number;
  lines: EngineLine[];
  grossA: number;
  totalB: number;
  totalC: number;
  net: number;
  /** things a reviewer should know (no rate for part of the month, loan capped, …) */
  warnings: string[];
}

export const A_COMPONENTS = ['Basic', 'House rent', 'Medical', 'Petrol', 'Other'] as const;
export const AUTO_C_COMPONENTS = ['Provident fund', 'EOBI', 'Withholding tax', 'Loan / advance'] as const;
export const B_SUGGESTIONS = [
  'Incentive',
  'Overtime',
  'Arrears',
  'Stipend',
  'Traveling allowance',
  'Bonus',
  'Gratuity',
  'Internet / mobile',
  'Waived amount',
] as const;


/** Annual tax on annual taxable income from the slabs: fixed + rate% × (income − from). */
export function annualTax(income: number, slabs: PayrollSettings['whtSlabs']): number {
  if (income <= 0) return 0;
  const slab = slabs.find((s) => income > s.from && (s.to === null || income <= s.to)) ?? slabs[0];
  if (!slab) return 0;
  return slab.fixed + (slab.rate / 100) * (income - slab.from);
}

/** Monthly withholding tax for a month's taxable pay, annualized ×12 then ÷12. */
export function monthlyWht(monthlyTaxable: number, slabs: PayrollSettings['whtSlabs']): number {
  return Math.round(annualTax(monthlyTaxable * 12, slabs) / 12);
}

export function computePayslip(input: EngineInput): EngineResult {
  const { month, settings } = input;
  const { start, end } = monthBounds(month);
  const basis = settings.prorationBasis;
  const calendarDays = daysBetweenInclusive(start, end);
  const workingDays = workingDaysBetween(start, end, input.weekendDays, input.holidays);
  const count = (from: ISODate, to: ISODate) =>
    from > to ? 0 : basis === 'working' ? workingDaysBetween(from, to, input.weekendDays, input.holidays) : daysBetweenInclusive(from, to);
  const daysOfMonth = basis === 'working' ? workingDays : calendarDays;
  const warnings: string[] = [];

  /* Rate periods ---------------------------------------------------- */
  const sorted = [...input.structures].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  const inForce = sorted.filter((s, i) => {
    const next = sorted[i + 1];
    const until = next ? addDays(next.effectiveFrom, -1) : end;
    return s.effectiveFrom <= end && until >= start;
  });
  const firstPayable = input.dateOfJoining > start ? input.dateOfJoining : start;
  if (inForce.length > 0 && inForce[0].effectiveFrom > firstPayable) {
    warnings.push(`No salary structure before ${inForce[0].effectiveFrom}; those days are not paid`);
  }

  const periods: EnginePeriod[] = inForce.map((s, i) => {
    const next = inForce[i + 1];
    const from = s.effectiveFrom > start ? s.effectiveFrom : start;
    const to = next ? addDays(next.effectiveFrom, -1) : end;
    const days = count(from, to);
    const notJoinedTo = addDays(input.dateOfJoining, -1);
    const beforeJoining = input.dateOfJoining > from ? count(from, notJoinedTo < to ? notJoinedTo : to) : 0;
    // days after the last working day are not paid, like days before joining
    const leftFrom = input.lastWorkingDay ? addDays(input.lastWorkingDay, 1) : null;
    const afterLeaving = leftFrom && leftFrom <= to ? count(leftFrom > from ? leftFrom : from, to) : 0;
    const notJoined = Math.min(days, beforeJoining + afterLeaving);
    return { structureId: s.id, from, to, monthlyGross: s.grossSalary, days, notJoined, unpaid: 0, paidDays: 0, amount: 0 };
  });
  if (input.lastWorkingDay && input.lastWorkingDay < end) {
    warnings.push(`Left on ${input.lastWorkingDay}; paid up to that day`);
  }

  /* Unpaid days: by date when known, else from the end of the month */
  const payableOf = (p: EnginePeriod) => Math.max(0, p.days - p.notJoined);
  if (input.unpaidDates && input.unpaidDates.length > 0) {
    for (const u of input.unpaidDates) {
      const p = periods.find((x) => u.date >= x.from && u.date <= x.to);
      if (p) p.unpaid += u.days;
    }
  } else {
    let left = Math.max(0, input.unpaidDays);
    for (let i = periods.length - 1; i >= 0 && left > 0; i--) {
      const take = Math.min(left, payableOf(periods[i]));
      periods[i].unpaid += take;
      left -= take;
    }
    if (left > 0) warnings.push(`${left} unpaid leave days fall outside the paid days of the month`);
  }

  for (const p of periods) {
    const payable = payableOf(p);
    if (p.unpaid > payable) p.unpaid = payable;
    p.paidDays = payable - p.unpaid;
    p.amount = daysOfMonth > 0 ? (p.monthlyGross / daysOfMonth) * p.paidDays : 0;
  }

  /* A: rounded once, components rounded, remainder on Basic --------- */
  const grossA = Math.round(periods.reduce((n, p) => n + p.amount, 0));
  const byId = new Map(inForce.map((s) => [s.id, s]));
  const compExact = (key: keyof EngineStructure) =>
    periods.reduce((n, p) => n + (daysOfMonth > 0 ? ((byId.get(p.structureId)![key] as number) / daysOfMonth) * p.paidDays : 0), 0);
  const others = [
    { component: 'House rent', amount: Math.round(compExact('houseRent')) },
    { component: 'Medical', amount: Math.round(compExact('medicalAllowance')) },
    { component: 'Petrol', amount: Math.round(compExact('petrolAllowance')) },
    { component: 'Other', amount: Math.round(compExact('otherAllowance')) },
  ];
  const basic = grossA - others.reduce((n, l) => n + l.amount, 0);
  const lines: EngineLine[] = [];
  let order = 0;
  if (grossA !== 0 || basic !== 0) lines.push({ section: 'A', component: 'Basic', amount: basic, isManual: false, sortOrder: order++ });
  for (const o of others) if (o.amount !== 0) lines.push({ section: 'A', ...o, isManual: false, sortOrder: order++ });

  /* B: computed additions, then manual ---------------------------------- */
  const autoB = (input.autoAdditions ?? []).filter((l) => l.amount !== 0);
  const manualB = input.manualLines.filter((l) => l.section === 'B');
  const totalB = autoB.reduce((n, l) => n + l.amount, 0) + manualB.reduce((n, l) => n + l.amount, 0);
  for (const l of autoB) lines.push({ section: 'B', component: l.component, amount: l.amount, isManual: false, sortOrder: order++ });
  for (const l of manualB) lines.push({ section: 'B', component: l.component, amount: l.amount, isManual: true, sortOrder: order++ });

  /* C: statutory, loan, manual --------------------------------------- */
  const latest = inForce[inForce.length - 1];
  const paidAnyDay = periods.some((p) => p.paidDays > 0);
  const auto: Array<{ component: string; amount: number }> = [];
  if (latest?.pfApplicable) {
    const pf = Math.round((basic * settings.pfPercentOfBasic) / 100);
    if (pf > 0) auto.push({ component: 'Provident fund', amount: pf });
  }
  if (latest?.eobiApplicable && paidAnyDay && settings.eobiEmployeeAmount > 0) {
    auto.push({ component: 'EOBI', amount: settings.eobiEmployeeAmount });
  }
  if (latest?.whtApplicable) {
    const wht = monthlyWht(grossA + totalB, settings.whtSlabs);
    if (wht > 0) auto.push({ component: 'Withholding tax', amount: wht });
  }
  const manualC = input.manualLines.filter((l) => l.section === 'C');
  const cSoFar = auto.reduce((n, l) => n + l.amount, 0) + manualC.reduce((n, l) => n + l.amount, 0);
  if (input.loan && input.loan.balance > 0 && input.loan.installment > 0) {
    const want = Math.min(input.loan.installment, input.loan.balance);
    const room = Math.max(0, grossA + totalB - cSoFar);
    const take = Math.min(want, room);
    if (take < want) warnings.push(`Loan installment reduced from ${want} to ${take} so net pay is not negative`);
    if (take > 0) auto.push({ component: 'Loan / advance', amount: take });
  }
  for (const l of auto) lines.push({ section: 'C', ...l, isManual: false, sortOrder: order++ });
  for (const l of manualC) lines.push({ section: 'C', component: l.component, amount: l.amount, isManual: true, sortOrder: order++ });
  const totalC = lines.filter((l) => l.section === 'C').reduce((n, l) => n + l.amount, 0);

  const net = grossA + totalB - totalC;
  if (net < 0) warnings.push(`Net pay is negative (${net})`);

  return {
    basis,
    calendarDays,
    workingDays,
    daysOfMonth,
    periods,
    currentSalaryDays: periods[0]?.paidDays ?? 0,
    newSalaryDays: periods.slice(1).reduce((n, p) => n + p.paidDays, 0),
    // days of this month before joining, whether or not a rate period covers them
    // (a salary that starts on the joining date leaves those days outside every period)
    notJoinedDays: input.dateOfJoining > start ? count(start, addDays(input.dateOfJoining, -1) < end ? addDays(input.dateOfJoining, -1) : end) : 0,
    unpaidDays: periods.reduce((n, p) => n + p.unpaid, 0),
    lines,
    grossA,
    totalB,
    totalC,
    net,
    warnings,
  };
}
