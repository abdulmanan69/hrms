/** Typed fetchers for the leave module (/api/v1/leave). */
import { api, downloadUrl, upload, type Paged } from '../lib/api';

export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type AccrualRule = 'annual' | 'monthly' | 'none';
export type LedgerEntryType = 'accrual' | 'application' | 'adjustment' | 'carry_forward' | 'reversal';

export interface LeaveEffect {
  paidDays: number;
  unpaidDays: number;
  balanceAfter: number | null;
}

export interface LeaveApplication {
  id: number;
  sipId: string;
  employeeName: string;
  departmentName: string | null;
  leaveTypeId: number;
  leaveTypeName: string;
  isPaid: boolean;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  totalDays: number;
  /** stored split: projected while pending, final once approved */
  unpaidDays: number;
  reason: string | null;
  attachmentName: string | null;
  status: LeaveStatus;
  approverName: string | null;
  decisionComment: string | null;
  decidedAt: string | null;
  createdByName: string | null;
  createdAt: string;
  hasAttachment: boolean;
  /** current balance of this type (null for unpaid types) */
  balance: number | null;
  /** pending: what approving now would do; approved: what it did */
  effect: LeaveEffect | null;
  canDecide: boolean;
  canCancel: boolean;
}

export interface LedgerEntry {
  id: number;
  leaveTypeId: number;
  leaveTypeName?: string;
  entryType: LedgerEntryType;
  days: number;
  entryDate: string;
  reference: string | null;
  note: string | null;
  balanceAfter: number;
  createdByName?: string | null;
  createdAt: string;
}

export interface LeaveApplicationDetail extends LeaveApplication {
  ledger: LedgerEntry[];
}

export interface BalanceCard {
  leaveTypeId: number;
  name: string;
  isPaid: boolean;
  entitlement: number;
  balance: number | null;
  takenThisYear: number;
  pending: number;
}

export interface LeaveType {
  id: number;
  name: string;
  annualEntitlementDays: number;
  isPaid: boolean;
  accrualRule: AccrualRule;
  carryForwardMax: number;
  requiresAttachment: boolean;
  active: boolean;
  sortOrder: number;
  applicationCount: number;
  ledgerCount: number;
}

export type LeaveTypeInput = Omit<LeaveType, 'id' | 'applicationCount' | 'ledgerCount'>;

export interface LeaveSettings {
  weekendDays: number[];
  holidays: string[];
}

export interface Quote {
  totalDays: number;
  workingDates: string[];
  isPaid: boolean;
  balance: number | null;
  pendingDays: number;
  paidDays: number;
  unpaidDays: number;
  balanceAfter: number | null;
  requiresAttachment: boolean;
  overlaps: Array<{ id: number; startDate: string; endDate: string; status: LeaveStatus }>;
}

export interface BalancesTable {
  types: Array<{ id: number; name: string; entitlement: number }>;
  data: Array<{ sipId: string; name: string; departmentName: string | null; dateOfJoining: string; balances: Record<string, number> }>;
}

export interface LeaveSummary {
  employee: { sipId: string; name: string; status: string; departmentName: string | null; dateOfJoining: string };
  balances: BalanceCard[];
  applications: LeaveApplication[];
  ledger: LedgerEntry[];
  canAdjust?: boolean;
  canDecide?: boolean;
}

export interface ApplicationFilters {
  scope?: 'all' | 'mine-to-approve';
  status?: LeaveStatus | 'all';
  leaveTypeId?: number | '';
  sipId?: string;
  departmentId?: number | '';
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface ApplyInput {
  sipId?: string;
  leaveTypeId: number;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  reason?: string;
}

/* ---------------- keys ---------------- */

export const leaveKeys = {
  all: ['leave'] as const,
  applications: (f: ApplicationFilters) => ['leave', 'applications', f] as const,
  application: (id: number) => ['leave', 'application', id] as const,
  today: ['leave', 'on-leave', 'today'] as const,
  upcoming: ['leave', 'upcoming'] as const,
  balances: (q: object) => ['leave', 'balances', q] as const,
  types: (includeInactive: boolean) => ['leave', 'types', includeInactive] as const,
  settings: ['leave', 'settings'] as const,
  summary: (sipId: string) => ['leave', 'summary', sipId] as const,
  mySummary: ['leave', 'me', 'summary'] as const,
  quote: (q: object) => ['leave', 'quote', q] as const,
};

/* ---------------- fetchers ---------------- */

export const leaveApi = {
  applications: (f: ApplicationFilters) => api<Paged<LeaveApplication>>('/leave/applications', { query: { ...f } }),
  application: (id: number) => api<LeaveApplicationDetail>(`/leave/applications/${id}`),
  approve: (id: number, comment?: string) => api<LeaveApplicationDetail>(`/leave/applications/${id}/approve`, { method: 'POST', body: { comment: comment || null } }),
  reject: (id: number, comment?: string) => api<LeaveApplicationDetail>(`/leave/applications/${id}/reject`, { method: 'POST', body: { comment: comment || null } }),
  cancel: (id: number, comment?: string) => api<LeaveApplicationDetail>(`/leave/applications/${id}/cancel`, { method: 'POST', body: { comment: comment || null } }),
  attachmentUrl: (id: number) => downloadUrl(`/leave/applications/${id}/attachment`),

  /** Applies for leave; HR may pass another employee's sipId. Sends multipart when a file is attached. */
  apply: (input: ApplyInput, file?: File | null) => {
    if (file) {
      const fields: Record<string, string> = {
        leaveTypeId: String(input.leaveTypeId),
        startDate: input.startDate,
        endDate: input.endDate,
        halfDay: String(input.halfDay),
        reason: input.reason ?? '',
      };
      if (input.sipId) fields.sipId = input.sipId;
      return upload<LeaveApplicationDetail>('/leave/applications', file, fields);
    }
    return api<LeaveApplicationDetail>('/leave/applications', { method: 'POST', body: input });
  },
  quote: (q: { sipId?: string; leaveTypeId: number; startDate: string; endDate: string; halfDay: boolean }) =>
    api<Quote>('/leave/quote', { query: q }),

  today: () => api<{ data: LeaveApplication[] }>('/leave/on-leave/today'),
  upcoming: (days = 14) => api<{ data: LeaveApplication[] }>('/leave/upcoming', { query: { days } }),

  balances: (q: { search?: string; departmentId?: number | '' }) => api<BalancesTable>('/leave/balances', { query: q }),
  balancesCsvUrl: (q: { search?: string; departmentId?: number | '' }) => downloadUrl('/leave/balances', { ...q, format: 'csv' }),
  adjust: (body: { sipId: string; leaveTypeId: number; days: number; note: string }) =>
    api<LedgerEntry>('/leave/adjustments', { method: 'POST', body }),
  runAccruals: () => api<{ written: number; asOf: string }>('/leave/accruals/run', { method: 'POST' }),

  summary: (sipId: string) => api<LeaveSummary>(`/leave/employees/${encodeURIComponent(sipId)}/summary`),
  ledger: (sipId: string, page = 1) => api<Paged<LedgerEntry>>(`/leave/employees/${encodeURIComponent(sipId)}/ledger`, { query: { page } }),

  mySummary: () => api<LeaveSummary>('/leave/me/summary'),
  myCancel: (id: number) => api<LeaveApplicationDetail>(`/leave/me/applications/${id}/cancel`, { method: 'POST', body: {} }),

  types: (includeInactive = false) => api<{ data: LeaveType[] }>('/leave/types', { query: { includeInactive } }),
  createType: (body: LeaveTypeInput) => api<LeaveType>('/leave/types', { method: 'POST', body }),
  updateType: (id: number, body: Partial<LeaveTypeInput>) => api<LeaveType>(`/leave/types/${id}`, { method: 'PATCH', body }),
  deleteType: (id: number) => api<{ deleted: boolean; deactivated: boolean }>(`/leave/types/${id}`, { method: 'DELETE' }),

  settings: () => api<LeaveSettings>('/leave/settings'),
  saveSettings: (body: LeaveSettings) => api<LeaveSettings>('/leave/settings', { method: 'PUT', body }),
};

/** Shared lookups (org module). */
export interface PersonOption {
  sipId: string;
  name: string;
  status: string;
  departmentName: string | null;
  designationTitle: string | null;
}
export const orgApi = {
  people: (search: string) => api<{ data: PersonOption[] }>('/org/people', { query: { search, status: 'all', limit: 20 } }),
  departments: () => api<{ data: Array<{ id: number; name: string; active: boolean; headcount: number }> }>('/org/departments'),
};
