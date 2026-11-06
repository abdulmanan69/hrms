import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTENDANCE, dueAt, isOffDay, judgeDay, mergeFacts, shiftDayOf, zonedInstant, type AttendanceSettings, type DayInput } from './attendance.js';

const S: AttendanceSettings = { ...DEFAULT_ATTENDANCE };
const pk = (local: string) => new Date(local + '+05:00');
const base: Omit<DayInput, 'facts'> = { day: '2026-11-02', today: '2026-11-06', manual: null, onLeave: false, offDay: false, expected: true };
const facts = (first: string, last: string, calls = 40) => ({ firstAt: pk(first), lastAt: pk(last), calls, talkSec: calls * 60 });

describe('shift days', () => {
  it('a 20:00 → 05:00 night shift is one day, dated the evening it began', () => {
    expect(shiftDayOf(pk('2026-11-02T20:00:00'), S)).toBe('2026-11-02');
    expect(shiftDayOf(pk('2026-11-03T05:00:00'), S)).toBe('2026-11-02');
  });
  it('the boundary is 12:00 Karachi time', () => {
    expect(shiftDayOf(pk('2026-11-03T11:59:00'), S)).toBe('2026-11-02');
    expect(shiftDayOf(pk('2026-11-03T12:00:00'), S)).toBe('2026-11-03');
  });
  it('local wall time to an instant', () => {
    expect(zonedInstant('2026-11-02', '20:00', 'Asia/Karachi').toISOString()).toBe('2026-11-02T15:00:00.000Z');
  });
  it('a shift start after midnight falls on the next calendar date', () => {
    expect(dueAt('2026-11-02', { ...S, shiftStart: '01:00' })!.toISOString()).toBe('2026-11-02T20:00:00.000Z');
    expect(dueAt('2026-11-02', { ...S, shiftStart: '19:00' })!.toISOString()).toBe('2026-11-02T14:00:00.000Z');
    expect(dueAt('2026-11-02', S)).toBeNull();
  });
});

describe('judging a day', () => {
  it('a full shift is present; lateness is not judged without a shift start', () => {
    expect(judgeDay({ ...base, facts: facts('2026-11-02T21:30:00', '2026-11-03T05:00:00') }, S).status).toBe('present');
  });
  it('late after the grace, with the minutes', () => {
    const s = { ...S, shiftStart: '20:00' };
    expect(judgeDay({ ...base, facts: facts('2026-11-02T20:10:00', '2026-11-03T05:00:00') }, s).status).toBe('present');
    const r = judgeDay({ ...base, facts: facts('2026-11-02T20:40:00', '2026-11-03T05:00:00') }, s);
    expect(r).toMatchObject({ status: 'late', lateMinutes: 40 });
  });
  it('first to last call under 4 hours is a half day', () => {
    expect(judgeDay({ ...base, facts: facts('2026-11-02T20:00:00', '2026-11-02T23:30:00') }, S).status).toBe('half_day');
  });
  it('no calls: leave, then off day, then absent only when expected', () => {
    expect(judgeDay({ ...base, facts: null, onLeave: true }, S).status).toBe('leave');
    expect(judgeDay({ ...base, facts: null, offDay: true }, S).status).toBe('off');
    expect(judgeDay({ ...base, facts: null }, S).status).toBe('absent');
    expect(judgeDay({ ...base, facts: null, expected: false }, S).status).toBeNull();
  });
  it('today is never judged; the future is empty', () => {
    expect(judgeDay({ ...base, day: '2026-11-06', facts: facts('2026-11-06T20:00:00', '2026-11-06T21:00:00') }, S).status).toBe('working');
    expect(judgeDay({ ...base, day: '2026-11-06', facts: null }, S).status).toBeNull();
    expect(judgeDay({ ...base, day: '2026-11-07', facts: null }, S).status).toBeNull();
  });
  it('a day HR set by hand wins', () => {
    expect(judgeDay({ ...base, facts: null, manual: { status: 'present', note: 'field visit' } }, S)).toMatchObject({ status: 'present', manual: true });
  });
});

describe('helpers', () => {
  it('merges two accounts on one day', () => {
    const m = mergeFacts([facts('2026-11-02T21:00:00', '2026-11-03T01:00:00', 10), facts('2026-11-02T20:30:00', '2026-11-03T04:00:00', 5)])!;
    expect(m.firstAt!.toISOString()).toBe(pk('2026-11-02T20:30:00').toISOString());
    expect(m.lastAt!.toISOString()).toBe(pk('2026-11-03T04:00:00').toISOString());
    expect(m.calls).toBe(15);
  });
  it('weekends and holidays from the Leave settings', () => {
    const leave = { weekendDays: [0, 6], holidays: ['2026-11-09'] };
    expect(isOffDay('2026-11-07', leave)).toBe(true); // Saturday
    expect(isOffDay('2026-11-09', leave)).toBe(true);
    expect(isOffDay('2026-11-10', leave)).toBe(false);
  });
});
