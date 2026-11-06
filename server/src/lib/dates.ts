/**
 * Calendar helpers on plain 'YYYY-MM-DD' strings. All math is done in UTC so a
 * date never shifts by a day because of the server's time zone.
 */
import { config } from '../config.js';

export type ISODate = string;

/** Today in the business time zone (Asia/Karachi by default). */
export function todayISO(): ISODate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.TZ_BUSINESS }).format(new Date());
}

export function parseISO(d: ISODate): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

export function toISO(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  const x = parseISO(d);
  x.setUTCDate(x.getUTCDate() + n);
  return toISO(x);
}

/** Inclusive day count, e.g. ('2026-07-01','2026-07-31') = 31. */
export function daysBetweenInclusive(from: ISODate, to: ISODate): number {
  return Math.round((parseISO(to).getTime() - parseISO(from).getTime()) / 86_400_000) + 1;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 'YYYY-MM' → first and last day */
export function monthBounds(month: string): { start: ISODate; end: ISODate } {
  return { start: `${month}-01`, end: `${month}-${String(daysInMonth(month)).padStart(2, '0')}` };
}

export function monthOf(d: ISODate): string {
  return d.slice(0, 7);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(d: ISODate): number {
  return parseISO(d).getUTCDay();
}

export function eachDay(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Working days in a range, skipping the given weekend days and holidays. */
export function workingDaysBetween(from: ISODate, to: ISODate, weekendDays: number[], holidays: ISODate[] = []): number {
  const off = new Set(holidays);
  return eachDay(from, to).filter((d) => !weekendDays.includes(weekday(d)) && !off.has(d)).length;
}

/** Overlap of two inclusive ranges, or null. */
export function overlap(aFrom: ISODate, aTo: ISODate, bFrom: ISODate, bTo: ISODate): { from: ISODate; to: ISODate } | null {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  return from <= to ? { from, to } : null;
}

export function isISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && toISO(parseISO(s)) === s;
}

export function isMonth(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}
