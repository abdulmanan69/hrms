/**
 * Attendance from the dialer, the same rules the CRM used (its migration 316):
 *
 *   A shift day runs from `dayStartsAt` local time to the same time the next
 *   day and is dated the day it began, so a 20:00 → 05:00 shift is one day.
 *   Systems such as the QA platform report, per person and shift day, the
 *   first and last call, the number of calls and talk time. HRMS keeps those
 *   facts and works the status out when it is read, so a rule change applies
 *   to past days too:
 *
 *     manual    HR set the day by hand: that wins
 *     working   today's shift day, with calls so far (never judged yet)
 *     leave     approved leave covers the day and there were no calls
 *     half_day  first → last call shorter than `halfDayBelowHours`
 *     late      first call later than shiftStart + lateAfterMinutes
 *               (only when shiftStart is set; no guessing)
 *     present   calls, none of the above
 *     off       weekend or public holiday (Leave settings), no calls
 *     absent    a past working day with no calls, for the people
 *               `absentFor` covers: 'dialer_agents' = anyone who dialed in
 *               the 30 days before, 'everyone' = every active employee,
 *               'none' = nobody
 */
import type { LeaveSettings } from './settings.js';
import { addDays } from '../lib/dates.js';

export type AttendanceStatus = 'present' | 'late' | 'half_day' | 'absent' | 'leave' | 'off' | 'working';
export const MANUAL_STATUSES = ['present', 'late', 'half_day', 'absent', 'leave', 'off'] as const;

export interface AttendanceSettings {
  /** IANA zone the shift times are in */
  timeZone: string;
  /** HH:MM local; the shift-day boundary */
  dayStartsAt: string;
  /** HH:MM local the shift starts; null = lateness is not judged */
  shiftStart: string | null;
  lateAfterMinutes: number;
  halfDayBelowHours: number;
  absentFor: 'dialer_agents' | 'everyone' | 'none';
}

export const DEFAULT_ATTENDANCE: AttendanceSettings = {
  timeZone: 'Asia/Karachi',
  dayStartsAt: '12:00',
  shiftStart: null,
  lateAfterMinutes: 15,
  halfDayBelowHours: 4,
  absentFor: 'dialer_agents',
};

/** Offset of `tz` from UTC at instant `at`, in minutes (Asia/Karachi → 300). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** The instant of local `day` `time` (HH:MM) in `tz`. */
export function zonedInstant(day: string, time: string, tz: string): Date {
  const [h, m] = time.split(':').map(Number);
  const wall = new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`).getTime();
  // the wall time read as UTC, corrected by the zone's offset; checked once more for DST edges
  let at = wall - tzOffsetMinutes(tz, new Date(wall)) * 60000;
  at = wall - tzOffsetMinutes(tz, new Date(at)) * 60000;
  return new Date(at);
}

/** The shift day an instant belongs to. */
export function shiftDayOf(at: Date, s: Pick<AttendanceSettings, 'timeZone' | 'dayStartsAt'>): string {
  const local = new Date(at.getTime() + tzOffsetMinutes(s.timeZone, at) * 60000);
  const [h, m] = s.dayStartsAt.split(':').map(Number);
  const shifted = new Date(local.getTime() - (h * 60 + m) * 60000);
  return shifted.toISOString().slice(0, 10);
}

/** When shift day `day` is due to start (shiftStart may fall after midnight, i.e. on the next calendar day). */
export function dueAt(day: string, s: AttendanceSettings): Date | null {
  if (!s.shiftStart) return null;
  const onNextDate = s.shiftStart < s.dayStartsAt;
  return zonedInstant(onNextDate ? addDays(day, 1) : day, s.shiftStart, s.timeZone);
}

export interface DayFacts {
  firstAt: Date | null;
  lastAt: Date | null;
  calls: number;
  talkSec: number;
}

export interface DayInput {
  day: string;
  /** today's shift day: still in progress */
  today: string;
  facts: DayFacts | null;
  manual: { status: (typeof MANUAL_STATUSES)[number]; note: string | null } | null;
  onLeave: boolean;
  /** weekend or holiday */
  offDay: boolean;
  /** absentFor says this person can be absent on this day */
  expected: boolean;
}

export interface DayResult {
  status: AttendanceStatus | null;
  lateMinutes: number | null;
  manual: boolean;
}

export function judgeDay(i: DayInput, s: AttendanceSettings): DayResult {
  if (i.manual) return { status: i.manual.status, lateMinutes: null, manual: true };
  const worked = !!i.facts && i.facts.calls > 0 && !!i.facts.firstAt;
  if (i.day > i.today) return { status: null, lateMinutes: null, manual: false };
  if (i.day === i.today) return { status: worked ? 'working' : null, lateMinutes: null, manual: false };
  if (!worked) {
    if (i.onLeave) return { status: 'leave', lateMinutes: null, manual: false };
    if (i.offDay) return { status: 'off', lateMinutes: null, manual: false };
    return { status: i.expected ? 'absent' : null, lateMinutes: null, manual: false };
  }
  const f = i.facts!;
  const hours = f.lastAt && f.firstAt ? (f.lastAt.getTime() - f.firstAt.getTime()) / 3_600_000 : 0;
  if (hours < s.halfDayBelowHours) return { status: 'half_day', lateMinutes: null, manual: false };
  const due = dueAt(i.day, s);
  if (due) {
    const late = Math.floor((f.firstAt!.getTime() - due.getTime()) / 60000);
    if (late > s.lateAfterMinutes) return { status: 'late', lateMinutes: late, manual: false };
  }
  return { status: 'present', lateMinutes: null, manual: false };
}

/** Weekend or public holiday under the Leave settings. */
export function isOffDay(day: string, leave: LeaveSettings): boolean {
  const dow = new Date(day + 'T00:00:00Z').getUTCDay();
  return leave.weekendDays.includes(dow) || leave.holidays.includes(day);
}

/** Merge several sources' facts for one person-day (two dialers, two accounts). */
export function mergeFacts(rows: DayFacts[]): DayFacts | null {
  if (!rows.length) return null;
  let firstAt: Date | null = null;
  let lastAt: Date | null = null;
  let calls = 0;
  let talkSec = 0;
  for (const r of rows) {
    if (r.firstAt && (!firstAt || r.firstAt < firstAt)) firstAt = r.firstAt;
    if (r.lastAt && (!lastAt || r.lastAt > lastAt)) lastAt = r.lastAt;
    calls += r.calls;
    talkSec += r.talkSec;
  }
  return { firstAt, lastAt, calls, talkSec };
}

export const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present',
  late: 'Late',
  half_day: 'Half day',
  absent: 'Absent',
  leave: 'Leave',
  off: 'Off',
  working: 'Working',
};
