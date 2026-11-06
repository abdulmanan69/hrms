/** Typed fetchers for sales and incentives. Paths are relative to /api/v1. */
import { api, type Paged } from '../lib/api';

export type SaleRole = 'closer' | 'fronter';

export interface Slab {
  from: number;
  rate: number;
}
export interface Plan {
  mode: 'reached' | 'stepped';
  slabs: Slab[];
}
export interface IncentivePlan {
  closer: Plan;
  fronter: Plan;
  includeInPayroll: boolean;
}

export interface SalesPerson {
  sipId: string;
  name: string;
  department: string | null;
  designation: string | null;
  closer: number;
  fronter: number;
  value: number;
  closerIncentive: number;
  fronterIncentive: number;
  incentive: number;
  closerToNext: number | null;
  fronterToNext: number | null;
}

export interface SalesSummary {
  month: string;
  closed: boolean;
  plan: IncentivePlan;
  totals: { closer: number; fronter: number; incentive: number; value: number; people: number; voided: number };
  byDay: Array<{ date: string; closer: number; fronter: number }>;
  people: SalesPerson[];
}

export interface Sale {
  id: number;
  sipId: string;
  name: string;
  department: string | null;
  role: SaleRole;
  saleDate: string;
  source: string;
  context: string;
  externalRef: string | null;
  externalUser: string | null;
  reference: string | null;
  amount: number | null;
  note: string | null;
  status: 'confirmed' | 'void';
  voidReason: string | null;
  createdAt: string;
}

export interface IncentiveResult {
  sales: number;
  amount: number;
  slab: Slab | null;
  steps: Array<{ from: number; to: number | null; rate: number; count: number; amount: number }>;
  toNext: number | null;
}

export interface PersonMonth {
  month: string;
  counts: { closer: number; fronter: number };
  incentive: { closer: IncentiveResult; fronter: IncentiveResult; total: number };
  plan: IncentivePlan;
  sales: Sale[];
}

export const salesApi = {
  summary: (month: string) => api<SalesSummary>('/sales/summary', { query: { month } }),
  list: (q: { month?: string; sipId?: string; role?: string; status?: string; search?: string; page?: number }) =>
    api<Paged<Sale>>('/sales', { query: { ...q, pageSize: 50 } }),
  create: (body: { sipId: string; fronterSipId?: string | null; saleDate: string; reference?: string | null; amount?: number | null; note?: string | null }) =>
    api<{ data: Sale[] }>('/sales', { method: 'POST', body }),
  void: (id: number, reason: string) => api(`/sales/${id}/void`, { method: 'POST', body: { reason } }),
  restore: (id: number) => api(`/sales/${id}/restore`, { method: 'POST', body: {} }),
  plan: () => api<IncentivePlan>('/sales/plan'),
  savePlan: (plan: IncentivePlan) => api<IncentivePlan>('/sales/plan', { method: 'PUT', body: plan }),
  person: (sipId: string, month: string) => api<PersonMonth>(`/sales/people/${encodeURIComponent(sipId)}`, { query: { month } }),
};

export const ROLE_LABEL: Record<SaleRole, string> = { closer: 'Closer', fronter: 'Fronter' };

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
