/** Typed fetchers for the payroll module. Paths are relative to /api/v1. */
import { api, downloadUrl, type Paged } from '../lib/api';

export type RunStatus = 'draft' | 'approved' | 'paid';
export type Section = 'A' | 'B' | 'C';

export interface Run {
  id: number;
  periodMonth: string;
  status: RunStatus;
  daysOfMonth: number;
  workingDays: number;
  notes: string | null;
  createdAt: string;
  approvedAt: string | null;
  paidAt: string | null;
  headcount: number;
  totalA: number;
  totalB: number;
  totalC: number;
  totalNet: number;
}

export interface Skipped {
  sipId: string;
  name: string;
  reason: string;
}

export interface NegativeNet {
  sipId: string;
  name: string;
  net: number;
}

export interface RunPayslipRow {
  id: number;
  sipId: string;
  name: string;
  departmentName: string | null;
  designationTitle: string | null;
  paidDays: number;
  hasIncrement: boolean;
  notJoinedDays: number;
  unpaidDays: number;
  grossA: number;
  totalAdditionsB: number;
  totalDeductionsC: number;
  netTotal: number;
  warnings: string[];
}

export interface RunDetail {
  run: Run;
  ledger: Array<{ section: Section; lines: Array<{ component: string; amount: number }> }>;
  payslips: RunPayslipRow[];
}

export interface RatePeriod {
  structureId: number;
  from: string;
  to: string;
  monthlyGross: number;
  days: number;
  notJoined: number;
  unpaid: number;
  paidDays: number;
  amount: number;
}

export interface PayslipLine {
  id: number;
  section: Section;
  component: string;
  amount: number;
  isManual: boolean;
}

export interface Payslip {
  id: number;
  runId: number;
  periodMonth: string;
  runStatus: RunStatus;
  paidAt: string | null;
  sipId: string;
  company: string;
  name: string;
  departmentName: string | null;
  designationTitle: string | null;
  employmentStatus: string;
  dateOfJoining: string;
  bankName: string | null;
  accountNo: string | null;
  cnic: string | null;
  basis: 'calendar' | 'working';
  daysOfMonth: number;
  calendarDays: number;
  workingDays: number;
  periods: RatePeriod[];
  warnings: string[];
  currentSalaryDays: number;
  newSalaryDays: number;
  notJoinedDays: number;
  unpaidDays: number;
  grossA: number;
  totalAdditionsB: number;
  totalDeductionsC: number;
  netTotal: number;
  computedAt: string;
  lines: PayslipLine[];
}

export interface PayslipSummary {
  id: number;
  runId: number;
  periodMonth: string;
  runStatus: RunStatus;
  grossA: number;
  totalAdditionsB: number;
  totalDeductionsC: number;
  netTotal: number;
  unpaidDays: number;
  paidAt: string | null;
}

export interface Structure {
  id: number;
  sipId: string;
  effectiveFrom: string;
  basicSalary: number;
  houseRent: number;
  medicalAllowance: number;
  petrolAllowance: number;
  otherAllowance: number;
  grossSalary: number;
  pfApplicable: boolean;
  eobiApplicable: boolean;
  whtApplicable: boolean;
  note: string | null;
  createdAt: string;
}

export interface StructureHistoryRow extends Structure {
  isCurrent: boolean;
  isFuture: boolean;
}

export interface EmployeeBrief {
  sipId: string;
  name: string;
  status: string;
  dateOfJoining: string;
  departmentName: string | null;
  designationTitle: string | null;
}

export interface StructureListRow extends EmployeeBrief {
  current: Structure | null;
  next: Structure | null;
  rows: number;
}

export interface NewStructure {
  sipId: string;
  effectiveFrom: string;
  basicSalary: number;
  houseRent: number;
  medicalAllowance: number;
  petrolAllowance: number;
  otherAllowance: number;
  pfApplicable: boolean;
  eobiApplicable: boolean;
  whtApplicable: boolean;
  note?: string;
}

export interface LoanRow {
  sipId: string;
  name: string;
  status: string;
  departmentName: string | null;
  balance: number;
  installment: number;
  lastEntryDate: string;
}

export interface LoanEntry {
  id: number;
  entryType: 'loan' | 'advance' | 'deduction' | 'waiver';
  amount: number;
  installment: number | null;
  entryDate: string;
  runId: number | null;
  periodMonth: string | null;
  note: string | null;
  balanceAfter: number;
  createdAt: string;
}

export interface WhtSlab {
  from: number;
  to: number | null;
  fixed: number;
  rate: number;
}

export interface PayrollRules {
  pfPercentOfBasic: number;
  eobiEmployeeAmount: number;
  whtSlabs: WhtSlab[];
  prorationBasis: 'calendar' | 'working';
  weekendDays?: number[];
}

export interface SalaryPanel {
  current: Structure | null;
  history: StructureHistoryRow[];
  loan: { balance: number; installment: number };
  payslips: PayslipSummary[];
}

export const B_COMPONENTS = [
  'Incentive',
  'Overtime',
  'Arrears',
  'Stipend',
  'Traveling allowance',
  'Bonus',
  'Gratuity',
  'Internet / mobile',
  'Waived amount',
];

export const payrollApi = {
  runs: () => api<{ data: Run[] }>('/payroll/runs'),
  createRun: (month: string) =>
    api<{ run: Run; skipped: Skipped[]; negative: NegativeNet[] }>('/payroll/runs', { method: 'POST', body: { month } }),
  run: (id: number) => api<RunDetail>(`/payroll/runs/${id}`),
  recompute: (id: number) =>
    api<{ run: Run; skipped: Skipped[]; removed: Skipped[]; negative: NegativeNet[] }>(`/payroll/runs/${id}/recompute`, { method: 'POST', body: {} }),
  approve: (id: number) => api<{ run: Run }>(`/payroll/runs/${id}/approve`, { method: 'POST', body: {} }),
  pay: (id: number) => api<{ run: Run }>(`/payroll/runs/${id}/pay`, { method: 'POST', body: {} }),
  reopen: (id: number) => api<{ run: Run }>(`/payroll/runs/${id}/reopen`, { method: 'POST', body: {} }),
  deleteRun: (id: number) => api<void>(`/payroll/runs/${id}`, { method: 'DELETE' }),
  exportUrl: (id: number) => downloadUrl(`/payroll/runs/${id}/export.csv`),
  bankUrl: (id: number) => downloadUrl(`/payroll/runs/${id}/bank.csv`),
  /** generated on request, never stored */
  runPdfUrl: (id: number) => downloadUrl(`/payroll/runs/${id}/payslips.pdf`),
  payslipPdfUrl: (id: number, download = true) => downloadUrl(`/payroll/payslips/${id}/pdf`, download ? { download: 1 } : undefined),

  payslip: (id: number) => api<Payslip>(`/payroll/payslips/${id}`),
  addLine: (id: number, body: { section: 'B' | 'C'; component: string; amount: number }) =>
    api<Payslip>(`/payroll/payslips/${id}/lines`, { method: 'POST', body }),
  updateLine: (id: number, lineId: number, body: { component?: string; amount?: number }) =>
    api<Payslip>(`/payroll/payslips/${id}/lines/${lineId}`, { method: 'PATCH', body }),
  removeLine: (id: number, lineId: number) => api<Payslip>(`/payroll/payslips/${id}/lines/${lineId}`, { method: 'DELETE' }),

  myPayslips: () => api<{ data: PayslipSummary[] }>('/payroll/me/payslips'),
  salaryPanel: (sipId: string) => api<SalaryPanel>(`/payroll/employees/${encodeURIComponent(sipId)}/salary`),

  structures: (query: { page: number; search?: string; departmentId?: number | ''; missing?: boolean }) =>
    api<Paged<StructureListRow> & { meta: { missing: number } }>('/payroll/structures', {
      query: { page: query.page, search: query.search, departmentId: query.departmentId || undefined, missing: query.missing ? 'true' : undefined },
    }),
  structureHistory: (sipId: string) =>
    api<{ employee: EmployeeBrief; current: Structure | null; data: StructureHistoryRow[] }>(`/payroll/structures/${encodeURIComponent(sipId)}`),
  addStructure: (body: NewStructure) => api<Structure>('/payroll/structures', { method: 'POST', body }),
  deleteStructure: (id: number) => api<void>(`/payroll/structures/rows/${id}`, { method: 'DELETE' }),

  loans: (query: { search?: string; all?: boolean }) =>
    api<{ data: LoanRow[] }>('/payroll/loans', { query: { search: query.search, all: query.all ? 'true' : undefined } }),
  loanLedger: (sipId: string) =>
    api<{ employee: EmployeeBrief; balance: number; installment: number; data: LoanEntry[] }>(`/payroll/loans/${encodeURIComponent(sipId)}`),
  giveLoan: (body: { sipId: string; type: 'loan' | 'advance'; amount: number; installment: number; entryDate: string; note?: string }) =>
    api<LoanEntry>('/payroll/loans', { method: 'POST', body }),
  loanEntry: (sipId: string, body: { type: 'repayment' | 'waiver'; amount: number; entryDate: string; note?: string }) =>
    api<LoanEntry>(`/payroll/loans/${encodeURIComponent(sipId)}/entries`, { method: 'POST', body }),

  rules: () => api<PayrollRules>('/payroll/settings'),
  saveRules: (body: PayrollRules) => api<PayrollRules>('/payroll/settings', { method: 'PUT', body }),
};

export function people(search: string) {
  return api<{ data: Array<{ sipId: string; name: string; status: string; departmentName: string | null; designationTitle: string | null }> }>(
    '/org/people',
    { query: { search, status: 'all', limit: 20 } },
  );
}

export function departmentsList() {
  return api<{ data: Array<{ id: number; name: string; active: boolean; headcount: number }> }>('/org/departments');
}
