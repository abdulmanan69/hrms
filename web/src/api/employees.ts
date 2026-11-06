/** Typed fetchers for the employee register (server: routes/employees.ts). */
import { api, downloadUrl, upload, type Paged } from '../lib/api';

export type EmployeeStatus = 'pending' | 'active' | 'inactive';
export type EmploymentStatus = 'probation' | 'contractual' | 'permanent';
export type DocumentType = 'resume' | 'cnic' | 'offer_letter' | 'contract' | 'other';

export const EMPLOYMENT_STATUSES: EmploymentStatus[] = ['probation', 'contractual', 'permanent'];
export const DOCUMENT_TYPES: DocumentType[] = ['cnic', 'contract', 'offer_letter', 'resume', 'other'];
export const DOCUMENT_LABELS: Record<DocumentType, string> = {
  cnic: 'CNIC copy',
  contract: 'Signed contract',
  offer_letter: 'Offer letter',
  resume: 'Resume',
  other: 'Other',
};

export interface EmployeeRow {
  sipId: string;
  firstName: string;
  middleInitial: string | null;
  lastName: string;
  name: string;
  email: string | null;
  phone: string | null;
  departmentId: number | null;
  departmentName: string | null;
  designationId: number | null;
  designationTitle: string | null;
  managerSipId: string | null;
  managerName: string | null;
  employmentStatus: EmploymentStatus;
  status: EmployeeStatus;
  dateOfJoining: string;
}

export interface EmployeeDocument {
  id: number;
  type: DocumentType;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedByName: string | null;
}

export interface EmployeeDetail {
  sipId: string;
  sourceCandidateId: number | null;
  firstName: string;
  middleInitial: string | null;
  lastName: string;
  name: string;
  /** cnic, dateOfBirth, bankName, accountNo are absent unless sensitiveVisible */
  cnic?: string | null;
  dateOfBirth?: string | null;
  bankName?: string | null;
  accountNo?: string | null;
  email: string | null;
  phone: string | null;
  altPhone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  gender: string | null;
  departmentId: number | null;
  departmentName: string | null;
  designationId: number | null;
  designationTitle: string | null;
  managerSipId: string | null;
  managerName: string | null;
  managerStatus: EmployeeStatus | null;
  employmentStatus: EmploymentStatus;
  dateOfJoining: string;
  status: EmployeeStatus;
  remarks: string | null;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  sensitiveVisible: boolean;
  linkedUser: { id: number; email: string; name: string; status: string } | null;
  directReports: Array<{ sipId: string; name: string; status: EmployeeStatus }>;
  blockers: string[];
  requiredDocuments: DocumentType[];
  documents: EmployeeDocument[];
}

export interface EmployeeSummary {
  total: number;
  active: number;
  pending: number;
  inactive: number;
  byDepartment: Array<{ departmentId: number | null; departmentName: string | null; active: number; pending: number; total: number }>;
}

export interface EmployeeFilters {
  search?: string;
  departmentId?: string;
  designationId?: string;
  status?: string;
  employmentStatus?: string;
  managerSipId?: string;
  sort?: string;
  dir?: string;
  page?: number;
  pageSize?: number;
}

export interface HistoryRow {
  id: number;
  action: string;
  entity: string;
  entityId: string | null;
  summary: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
  userId: number | null;
  userName: string | null;
}

export interface BlockedEmployee {
  sipId: string;
  name: string;
  departmentName: string | null;
  designationTitle: string | null;
  dateOfJoining: string;
  missing: string[];
  missingTypes: DocumentType[];
  ready: boolean;
}

export interface DocumentListRow extends EmployeeDocument {
  sipId: string;
  employeeName: string;
  employeeStatus: EmployeeStatus;
}

export interface BulkResult {
  results: Array<{ sipId: string; name: string | null; ok: boolean; status: EmployeeStatus | null; message: string }>;
  succeeded: number;
  failed: number;
}

/** Body for create/update. Empty strings clear a field. */
export type EmployeeInput = Partial<{
  firstName: string;
  middleInitial: string | null;
  lastName: string;
  gender: string | null;
  dateOfBirth: string | null;
  cnic: string | null;
  email: string | null;
  phone: string | null;
  altPhone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  departmentId: number | null;
  designationId: number | null;
  managerSipId: string | null;
  employmentStatus: EmploymentStatus;
  dateOfJoining: string;
  bankName: string | null;
  accountNo: string | null;
  remarks: string | null;
}>;

export type ContactInput = Pick<EmployeeInput, 'email' | 'phone' | 'altPhone' | 'address1' | 'address2' | 'city' | 'state' | 'postalCode' | 'country'>;

/* Lookups from /org (shared endpoints) */
export interface Department {
  id: number;
  name: string;
  active: boolean;
  headcount: number;
}
export interface Designation {
  id: number;
  title: string;
  departmentId: number | null;
  departmentName: string | null;
  active: boolean;
}
export interface Person {
  sipId: string;
  name: string;
  status: EmployeeStatus;
  departmentName: string | null;
  designationTitle: string | null;
}

const enc = encodeURIComponent;

export const employeesApi = {
  list: (f: EmployeeFilters) => api<Paged<EmployeeRow>>('/employees', { query: { ...f } }),
  summary: (f: EmployeeFilters) => api<EmployeeSummary>('/employees/summary', { query: { ...f, status: undefined, page: undefined } }),
  exportUrl: (f: EmployeeFilters) => downloadUrl('/employees/export', { ...f, page: undefined, pageSize: undefined }),
  get: (sipId: string) => api<EmployeeDetail>(`/employees/${enc(sipId)}`),
  create: (body: EmployeeInput) => api<EmployeeDetail>('/employees', { method: 'POST', body }),
  update: (sipId: string, body: EmployeeInput) => api<EmployeeDetail>(`/employees/${enc(sipId)}`, { method: 'PATCH', body }),
  activate: (sipId: string) => api<EmployeeDetail>(`/employees/${enc(sipId)}/activate`, { method: 'POST' }),
  deactivate: (sipId: string, reason: string) => api<EmployeeDetail>(`/employees/${enc(sipId)}/deactivate`, { method: 'POST', body: { reason } }),
  reactivate: (sipId: string, reason?: string) =>
    api<EmployeeDetail>(`/employees/${enc(sipId)}/reactivate`, { method: 'POST', body: reason ? { reason } : {} }),
  bulkStatus: (sipIds: string[], action: 'activate' | 'deactivate', reason?: string) =>
    api<BulkResult>('/employees/bulk-status', { method: 'POST', body: { sipIds, action, reason } }),
  history: (sipId: string, page = 1) => api<Paged<HistoryRow>>(`/employees/${enc(sipId)}/history`, { query: { page, pageSize: 50 } }),

  uploadDocument: (sipId: string, type: DocumentType, file: File) =>
    upload<{ document: EmployeeDocument; blockers: string[] }>(`/employees/${enc(sipId)}/documents`, file, { type }),
  deleteDocument: (sipId: string, docId: number) =>
    api<{ ok: true; blockers: string[] }>(`/employees/${enc(sipId)}/documents/${docId}`, { method: 'DELETE' }),
  documentUrl: (sipId: string, docId: number, download = false) =>
    downloadUrl(`/employees/${enc(sipId)}/documents/${docId}/download`, download ? { download: 1 } : undefined),
  blocked: () => api<{ data: BlockedEmployee[] }>('/employees/documents/blocked'),
  documents: (q: { type?: string; search?: string; sipId?: string; page?: number }) =>
    api<Paged<DocumentListRow>>('/employees/documents', { query: { ...q, pageSize: 25 } }),

  me: () => api<EmployeeDetail>('/employees/me'),
  updateMe: (body: ContactInput) => api<EmployeeDetail>('/employees/me', { method: 'PATCH', body }),

  departments: () => api<{ data: Department[] }>('/org/departments'),
  designations: () => api<{ data: Designation[] }>('/org/designations'),
  people: (q: { search?: string; status?: string; limit?: number }) => api<{ data: Person[] }>('/org/people', { query: q }),
  createDepartment: (name: string) => api<Department>('/org/departments', { method: 'POST', body: { name } }),
  updateDepartment: (id: number, body: { name?: string; active?: boolean }) => api<Department>(`/org/departments/${id}`, { method: 'PATCH', body }),
  createDesignation: (title: string, departmentId: number | null) =>
    api<Designation>('/org/designations', { method: 'POST', body: { title, departmentId } }),
  updateDesignation: (id: number, body: { title?: string; departmentId?: number | null; active?: boolean }) =>
    api<Designation>(`/org/designations/${id}`, { method: 'PATCH', body }),
};

/** Query keys: everything under ['employees'] so one invalidate refreshes the module. */
export const empKeys = {
  all: ['employees'] as const,
  list: (f: EmployeeFilters) => ['employees', 'list', f] as const,
  summary: (f: EmployeeFilters) => ['employees', 'summary', f] as const,
  detail: (sipId: string) => ['employees', 'detail', sipId] as const,
  history: (sipId: string) => ['employees', 'history', sipId] as const,
  me: ['employees', 'me'] as const,
  blocked: ['employees', 'blocked'] as const,
  documents: (q: object) => ['employees', 'documents', q] as const,
  departments: ['employees', 'org', 'departments'] as const,
  designations: ['employees', 'org', 'designations'] as const,
  people: (q: object) => ['employees', 'org', 'people', q] as const,
};
