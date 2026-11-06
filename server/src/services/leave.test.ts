import { describe, expect, it } from 'vitest';
import { countLeaveDays, coverable, splitDays } from './leave.js';
import { allocateUnpaid } from './leaveUnpaid.js';

const settings = { weekendDays: [0, 6], holidays: ['2026-12-25'] };

describe('countLeaveDays', () => {
  it('skips weekends and holidays', () => {
    expect(countLeaveDays('2026-11-20', '2026-11-24', false, settings)).toBe(3); // Fri, Mon, Tue
    expect(countLeaveDays('2026-12-21', '2026-12-25', false, settings)).toBe(4);
  });
  it('counts a half day as 0.5', () => {
    expect(countLeaveDays('2026-11-19', '2026-11-19', true, settings)).toBe(0.5);
  });
  it('rejects zero-day ranges, reversed ranges and multi-day half days', () => {
    expect(() => countLeaveDays('2026-11-07', '2026-11-08', false, settings)).toThrow(/no leave days/);
    expect(() => countLeaveDays('2026-11-10', '2026-11-09', false, settings)).toThrow(/before the start/);
    expect(() => countLeaveDays('2026-11-10', '2026-11-11', true, settings)).toThrow(/half day/);
  });
});

describe('splitDays', () => {
  it('pays what the balance covers, in half days', () => {
    expect(splitDays(5, true, 3)).toEqual({ paidDays: 3, unpaidDays: 2 });
    expect(splitDays(2, true, 0.83)).toEqual({ paidDays: 0.5, unpaidDays: 1.5 });
    expect(splitDays(2, true, -1)).toEqual({ paidDays: 0, unpaidDays: 2 });
    expect(splitDays(2, false, 10)).toEqual({ paidDays: 0, unpaidDays: 2 });
    expect(coverable(2.99)).toBe(2.5);
  });
});

describe('allocateUnpaid', () => {
  it('takes unpaid days from the end of the leave', () => {
    const dates = ['2026-11-26', '2026-11-27', '2026-11-30', '2026-12-01', '2026-12-02'];
    expect(allocateUnpaid({ startDate: '2026-11-26', endDate: '2026-12-02', unpaidDays: 4, halfDay: false }, dates)).toEqual({
      '2026-12': 2,
      '2026-11': 2,
    });
    expect(allocateUnpaid({ startDate: '2026-11-19', endDate: '2026-11-19', unpaidDays: 0.5, halfDay: true }, ['2026-11-19'])).toEqual({
      '2026-11': 0.5,
    });
  });
});
