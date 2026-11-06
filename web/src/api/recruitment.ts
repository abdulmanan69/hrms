/** Typed fetchers and shapes for the Recruitment / ATS API (/api/v1/recruitment). */
import { api, downloadUrl, type Paged } from '../lib/api';

export const STAGES = [
  'application_received',
  'screening',
  'interview_scheduled',
  'interview_completed',
  'feedback_received',
  'offer_made',
  'offer_accepted',
  'offer_rejected',
  'hired',
  'onboarding',
] as const;
export type Stage = (typeof STAGES)[number];

/** Columns of the pipeline board. */
export const BOARD_STAGES: Stage[] = STAGES.slice(0, 7) as Stage[];

/** Stages shown on the progress strip; offer_rejected is a branch, not a step. */
export const STRIP_STAGES: Stage[] = STAGES.filter((s) => s !== 'offer_rejected');

export const STATUSES = ['pending', 'screening', 'interviewed', 'offered', 'rejected', 'hired'] as const;
export type Status = (typeof STATUSES)[number];

export const SOURCE_HINT = 'e.g. VDAD, TMC100753, referral';

export type Mode = 'phone' | 'online' | 'in_person';
export type Outcome = 'positive' | 'neutral' | 'negative';
export type Channel = 'email' | 'whatsapp' | 'call';
export type Direction = 'inbound' | 'outbound';

export const MODE_LABEL: Record<Mode, string> = { phone: 'Phone', online: 'Online', in_person: 'In person' };
export const CHANNEL_LABEL: Record<Channel, string> = { email: 'Email', whatsapp: 'WhatsApp', call: 'Call' };

export function candidateCode(id: number): string {
  return `C-${String(id).padStart(5, '0')}`;
}

export function isClosed(status: Status): boolean {
  return status === 'rejected' || status === 'hired';
}

/* ------------------------------------------------------------------ */
/* Shapes                                                               */
/* ------------------------------------------------------------------ */

export interface RecruitUser {
  id: number;
  name: string;
  email: string;
  recruiter: boolean;
}

export interface BoardItem {
  applicationId: number;
  candidateId: number;
  name: string;
  positionApplied: string;
  stage: Stage;
  status: Status;
  priorityRank: number | null;
  ownerId: number | null;
  ownerName: string | null;
  nextFollowupDate: string | null;
  daysInStage: number;
}

export interface Board {
  today: string;
  columns: Array<{ stage: Stage; label: string; items: BoardItem[] }>;
  hired: { total: number; thisMonth: number };
}

export interface CandidateRow {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  source: string | null;
  createdAt: string;
  applicationId: number | null;
  positionApplied: string | null;
  applicationDate: string | null;
  status: Status | null;
  currentStage: Stage | null;
  nextFollowupDate: string | null;
  hiredSipId: string | null;
  ownerId: number | null;
  ownerName: string | null;
  applicationCount: number;
}

export interface CandidateFilters {
  search?: string;
  position?: string;
  status?: string;
  stage?: string;
  source?: string;
  ownerId?: number | string;
  from?: string;
  to?: string;
}

export interface CandidateInput {
  firstName: string;
  middleInitial?: string | null;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  altPhone?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  gender?: string | null;
  dateOfBirth?: string | null;
  source?: string | null;
  notes?: string | null;
}

export interface ApplicationInput {
  positionApplied: string;
  departmentId?: number | null;
  applicationDate?: string;
  priorityRank?: number | null;
  ownerRecruiterId?: number | null;
  nextFollowupDate?: string | null;
}

export interface Candidate extends Required<CandidateInput> {
  id: number;
  code: string;
  name: string;
  cnic: string | null;
  createdAt: string;
}

export interface Application {
  id: number;
  positionApplied: string;
  departmentId: number | null;
  departmentName: string | null;
  applicationDate: string;
  status: Status;
  currentStage: Stage;
  priorityRank: number | null;
  ownerId: number | null;
  ownerName: string | null;
  nextFollowupDate: string | null;
  hiredSipId: string | null;
  daysInStage: number;
  createdAt: string;
  updatedAt: string;
}

export interface StageEvent {
  id: number;
  applicationId: number;
  fromStage: Stage | null;
  toStage: Stage;
  note: string | null;
  userName: string | null;
  at: string;
}

export interface Interview {
  id: number;
  applicationId: number;
  candidateId?: number;
  candidateName?: string;
  positionApplied: string | null;
  stage?: Stage;
  scheduledAt: string;
  mode: Mode;
  interviewerIds: number[];
  interviewers: Array<{ id: number; name: string }>;
  outcome: Outcome | null;
  rating: number | null;
  feedbackNotes: string | null;
  followupAction: string | null;
}

export interface Communication {
  id: number;
  channel: Channel;
  direction: Direction;
  subject: string | null;
  summary: string | null;
  occurredAt: string;
  nextFollowupDate: string | null;
  userName: string | null;
}

export interface CandidateDetail {
  candidate: Candidate;
  applications: Application[];
  stageHistory: StageEvent[];
  interviews: Interview[];
  communications: Communication[];
}

export interface Followup {
  applicationId: number;
  candidateId: number;
  name: string;
  positionApplied: string;
  stage: Stage;
  nextFollowupDate: string;
  ownerId: number | null;
  ownerName: string | null;
  lastContactAt: string | null;
  overdue: boolean;
  dueToday: boolean;
}

export interface Summary {
  totals: {
    candidates: number;
    applications: number;
    open: number;
    hired: number;
    rejected: number;
    followupsDue: number;
    interviewsUpcoming: number;
  };
  byStage: Array<{ stage: Stage; label: string; count: number }>;
  hiresThisMonth: number;
  month: string;
  recent: Array<{ id: number; at: string; userName: string | null; summary: string | null; entity: string; entityId: string | null }>;
}

export interface HireInput {
  dateOfJoining: string;
  departmentId: number;
  designationId: number;
  employmentStatus: 'probation' | 'contractual' | 'permanent';
  managerSipId?: string | null;
  cnic?: string | null;
  confirm?: boolean;
}

/* ------------------------------------------------------------------ */
/* Fetchers                                                             */
/* ------------------------------------------------------------------ */

const R = '/recruitment';

export const recruitmentApi = {
  users: () => api<{ data: RecruitUser[] }>(`${R}/users`).then((r) => r.data),
  positions: () => api<{ data: string[] }>(`${R}/positions`).then((r) => r.data),
  summary: () => api<Summary>(`${R}/summary`),
  board: (q: { position?: string; ownerId?: number | string; search?: string }) => api<Board>(`${R}/pipeline`, { query: q }),

  candidates: (q: CandidateFilters & { page: number; pageSize?: number }) =>
    api<Paged<CandidateRow>>(`${R}/candidates`, { query: { ...q } }),
  exportUrl: (q: CandidateFilters) => downloadUrl(`${R}/candidates/export.csv`, { ...q }),
  candidate: (id: number) => api<CandidateDetail>(`${R}/candidates/${id}`),
  createCandidate: (body: CandidateInput & { application: ApplicationInput; force?: boolean }) =>
    api<{ candidate: Candidate; application: Application }>(`${R}/candidates`, { method: 'POST', body }),
  updateCandidate: (id: number, body: Partial<CandidateInput> & { force?: boolean }) =>
    api<Candidate>(`${R}/candidates/${id}`, { method: 'PATCH', body }),
  deleteCandidate: (id: number) => api<{ ok: true }>(`${R}/candidates/${id}`, { method: 'DELETE' }),

  addApplication: (candidateId: number, body: ApplicationInput) =>
    api<Application>(`${R}/candidates/${candidateId}/applications`, { method: 'POST', body }),
  updateApplication: (id: number, body: Partial<ApplicationInput>) => api<Application>(`${R}/applications/${id}`, { method: 'PATCH', body }),
  moveStage: (id: number, body: { stage: Stage; note?: string | null; fromStage?: Stage }) =>
    api<Application>(`${R}/applications/${id}/stage`, { method: 'POST', body }),
  reject: (id: number, reason?: string | null) => api<Application>(`${R}/applications/${id}/reject`, { method: 'POST', body: { reason } }),
  hire: (id: number, body: HireInput) =>
    api<{ sipId: string; application: Application }>(`${R}/applications/${id}/hire`, { method: 'POST', body }),

  interviews: (q: { scope: 'upcoming' | 'past' | 'all'; page: number; pageSize?: number; mode?: string; outcome?: string; search?: string; interviewerId?: number | string }) =>
    api<Paged<Interview>>(`${R}/interviews`, { query: q }),
  scheduleInterview: (body: { applicationId: number; scheduledAt: string; mode: Mode; interviewerIds: number[]; note?: string }) =>
    api<{ interview: Interview }>(`${R}/interviews`, { method: 'POST', body }),
  updateInterview: (
    id: number,
    body: Partial<{ scheduledAt: string; mode: Mode; interviewerIds: number[]; outcome: Outcome | null; rating: number | null; feedbackNotes: string | null; followupAction: string | null }>,
  ) => api<{ interview: Interview }>(`${R}/interviews/${id}`, { method: 'PATCH', body }),

  logContact: (
    candidateId: number,
    body: { channel: Channel; direction: Direction; subject?: string | null; summary?: string | null; occurredAt?: string; nextFollowupDate?: string | null; applicationId?: number },
  ) => api<{ communication: Communication }>(`${R}/candidates/${candidateId}/communications`, { method: 'POST', body }),
  followups: (scope: 'due' | 'all' = 'due') => api<{ today: string; data: Followup[] }>(`${R}/followups`, { query: { scope } }),
};

/* ------------------------------------------------------------------ */
/* Shared lookups (other modules' endpoints, read only)                 */
/* ------------------------------------------------------------------ */

export interface Department {
  id: number;
  name: string;
  active: boolean;
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
  status: string;
  departmentName: string | null;
  designationTitle: string | null;
}

export const orgApi = {
  departments: () => api<{ data: Department[] }>('/org/departments').then((r) => r.data),
  designations: () => api<{ data: Designation[] }>('/org/designations').then((r) => r.data),
  people: (search?: string) => api<{ data: Person[] }>('/org/people', { query: { search, status: 'active', limit: 200 } }).then((r) => r.data),
};
