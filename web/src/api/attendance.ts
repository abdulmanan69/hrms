/** Typed fetchers for attendance. Paths are relative to /api/v1. */
import { api } from '../lib/api';

export type AttendanceStatus = 'present' | 'late' | 'half_day' | 'absent' | 'leave' | 'off' | 'working';
export type ManualStatus = Exclude<AttendanceStatus, 'working'>;
export const MANUAL_STATUSES: ManualStatus[] = ['present', 'late', 'half_day', 'absent', 'leave', 'off'];

export interface AttendanceSettings {
  timeZone: string;
  dayStartsAt: string;
  shiftStart: string | null;
  lateAfterMinutes: number;
  halfDayBelowHours: number;
  absentFor: 'dialer_agents' | 'everyone' | 'none';
}

export interface PersonDay {
  day: string;
  status: AttendanceStatus | null;
  manual: boolean;
  note: string | null;
  firstAt: string | null;
  lastAt: string | null;
  calls: number;
  talkSec: number;
  lateMinutes: number | null;
}

export interface Totals {
  present: number;
  late: number;
  half_day: number;
  absent: number;
  leave: number;
  off: number;
  working: number;
  calls: number;
  talkSec: number;
}

export interface GridRow {
  sipId: string;
  name: string;
  department: string | null;
  dateOfJoining: string;
  totals: Totals;
  days: PersonDay[];
}

export interface Grid {
  month: string;
  settings: AttendanceSettings;
  today: string;
  lastSync: string | null;
  data: GridRow[];
}

export interface PersonMonth {
  month: string;
  person: { sipId: string; name: string; department: string | null };
  settings: AttendanceSettings;
  today: string;
  totals: Totals;
  days: PersonDay[];
}

export const attendanceApi = {
  grid: (q: { month: string; department?: number; q?: string }) => api<Grid>('/attendance', { query: q }),
  person: (sipId: string, month: string) => api<PersonMonth>(`/attendance/people/${encodeURIComponent(sipId)}`, { query: { month } }),
  setDay: (sipId: string, day: string, body: { status: ManualStatus; note?: string | null }) =>
    api(`/attendance/people/${encodeURIComponent(sipId)}/${day}`, { method: 'PUT', body }),
  clearDay: (sipId: string, day: string) => api(`/attendance/people/${encodeURIComponent(sipId)}/${day}`, { method: 'DELETE' }),
  settings: () => api<AttendanceSettings>('/attendance/settings'),
  saveSettings: (s: AttendanceSettings) => api<AttendanceSettings>('/attendance/settings', { method: 'PUT', body: s }),
};

export const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present',
  late: 'Late',
  half_day: 'Half day',
  absent: 'Absent',
  leave: 'Leave',
  off: 'Off',
  working: 'Working now',
};

/** One-letter mark for the month grid. */
export const STATUS_MARK: Record<AttendanceStatus, string> = {
  present: 'P',
  late: 'L',
  half_day: 'H',
  absent: 'A',
  leave: 'V',
  off: '',
  working: '•',
};

/** Cell classes per status: quiet neutrals, colour only where it means something. */
export const STATUS_CELL: Record<AttendanceStatus, string> = {
  present: 'bg-good-soft text-good',
  late: 'bg-warn-soft text-warn',
  half_day: 'bg-warn-soft text-warn',
  absent: 'bg-bad-soft text-bad',
  leave: 'bg-brand-soft text-brand',
  off: 'bg-raised text-ink-3',
  working: 'bg-good-soft text-good',
};

/** "7h 40m" */
export function hoursMinutes(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

/** Local clock time in the attendance time zone, "9:42 PM". */
export function clock(iso: string | null, timeZone: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** first → last call span in seconds */
export function spanSec(d: PersonDay): number {
  return d.firstAt && d.lastAt ? Math.max(0, (Date.parse(d.lastAt) - Date.parse(d.firstAt)) / 1000) : 0;
}
