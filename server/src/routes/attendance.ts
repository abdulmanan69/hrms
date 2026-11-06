/**
 * Attendance. Mounted at /api/v1/attendance.
 *
 *   GET    /attendance?month=&department=&q=      month grid: everyone, every shift day
 *   GET    /attendance/people/:sipId?month=        one person's month (profile, self-service)
 *   PUT    /attendance/people/:sipId/:day          set a day by hand { status, note }
 *   DELETE /attendance/people/:sipId/:day          hand the day back to the dialer
 *   GET    /attendance/settings, PUT …             shift-day rules
 *
 * Systems report dialer activity through /connect/:system/attendance; the
 * status each day shows is worked out here (services/attendance.ts).
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, gte, ilike, inArray, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import type { DbOrTx } from '../db/client.js';
import { attendanceDays, departments, employees, leaveApplications } from '../db/schema.js';
import { assertCanReadEmployee, can, requirePermission } from '../auth/plugin.js';
import type { AuthContext } from '../auth/session.js';
import { writeAudit } from '../lib/audit.js';
import { addDays, isISODate, isMonth, monthBounds, todayISO } from '../lib/dates.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { employeeNameSql } from '../services/people.js';
import { getSetting, setSetting } from '../services/settings.js';
import {
  MANUAL_STATUSES,
  STATUS_LABEL,
  isOffDay,
  judgeDay,
  mergeFacts,
  shiftDayOf,
  type AttendanceSettings,
  type AttendanceStatus,
  type DayFacts,
} from '../services/attendance.js';

const month = z.string().refine(isMonth, 'Month is YYYY-MM');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Times are HH:MM');
const settingsSchema = z.object({
  timeZone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone'),
  dayStartsAt: hhmm,
  shiftStart: hhmm.nullable(),
  lateAfterMinutes: z.number().int().min(0).max(240),
  halfDayBelowHours: z.number().min(0).max(24),
  absentFor: z.enum(['dialer_agents', 'everyone', 'none']),
});

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

interface Person {
  sipId: string;
  name: string;
  department: string | null;
  dateOfJoining: string;
}

/** Every day of the range for these people, judged. */
export async function buildDays(tx: DbOrTx, people: Person[], from: string, to: string): Promise<Map<string, PersonDay[]>> {
  const out = new Map<string, PersonDay[]>();
  if (!people.length) return out;
  const sips = people.map((p) => p.sipId);
  const s = (await getSetting(tx, 'attendance')) as AttendanceSettings;
  const leaveRules = await getSetting(tx, 'leave');
  const today = shiftDayOf(new Date(), s);
  const lookback = addDays(from, -30);

  const rows = await tx
    .select()
    .from(attendanceDays)
    .where(and(inArray(attendanceDays.sipId, sips), gte(attendanceDays.day, lookback), lte(attendanceDays.day, to)));
  const leave = await tx
    .select({ sipId: leaveApplications.sipId, startDate: leaveApplications.startDate, endDate: leaveApplications.endDate })
    .from(leaveApplications)
    .where(and(inArray(leaveApplications.sipId, sips), eq(leaveApplications.status, 'approved'), lte(leaveApplications.startDate, to), gte(leaveApplications.endDate, from)));

  const facts = new Map<string, DayFacts[]>();
  const manual = new Map<string, { status: (typeof MANUAL_STATUSES)[number]; note: string | null }>();
  const dialed = new Map<string, string[]>(); // sip → days with calls, for "expected"
  for (const r of rows) {
    const k = `${r.sipId} ${r.day}`;
    if (r.source === 'manual') {
      manual.set(k, { status: r.status as (typeof MANUAL_STATUSES)[number], note: r.note });
      continue;
    }
    if (r.calls > 0) dialed.set(r.sipId, [...(dialed.get(r.sipId) ?? []), r.day]);
    if (r.day < from) continue;
    facts.set(k, [...(facts.get(k) ?? []), { firstAt: r.firstAt, lastAt: r.lastAt, calls: r.calls, talkSec: r.talkSec }]);
  }
  const onLeave = (sip: string, day: string) => leave.some((l) => l.sipId === sip && l.startDate <= day && l.endDate >= day);

  for (const p of people) {
    const days: PersonDay[] = [];
    const myDialed = dialed.get(p.sipId) ?? [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const k = `${p.sipId} ${d}`;
      const f = mergeFacts(facts.get(k) ?? []);
      const m = manual.get(k) ?? null;
      const before = d >= p.dateOfJoining;
      const expected =
        before &&
        (s.absentFor === 'everyone' || (s.absentFor === 'dialer_agents' && myDialed.some((x) => x < d && x >= addDays(d, -30))));
      const r = judgeDay({ day: d, today, facts: f, manual: m, onLeave: onLeave(p.sipId, d), offDay: isOffDay(d, leaveRules), expected }, s);
      days.push({
        day: d,
        status: r.status,
        manual: r.manual,
        note: m?.note ?? null,
        firstAt: f?.firstAt?.toISOString() ?? null,
        lastAt: f?.lastAt?.toISOString() ?? null,
        calls: f?.calls ?? 0,
        talkSec: f?.talkSec ?? 0,
        lateMinutes: r.lateMinutes,
      });
    }
    out.set(p.sipId, days);
  }
  return out;
}

export function totalsOf(days: PersonDay[]) {
  const t = { present: 0, late: 0, half_day: 0, absent: 0, leave: 0, off: 0, working: 0, calls: 0, talkSec: 0 };
  for (const d of days) {
    if (d.status) t[d.status]++;
    t.calls += d.calls;
    t.talkSec += d.talkSec;
  }
  return t;
}

/** Whose attendance the caller may see: everyone, their team and themselves, or only themselves. */
function scope(auth: AuthContext): SQL | undefined {
  if (can(auth, 'attendance.view')) return undefined;
  if (can(auth, 'team.view') && auth.sipId) return or(eq(employees.managerSipId, auth.sipId), eq(employees.sipId, auth.sipId));
  throw new ForbiddenError('Missing permission: attendance.view or team.view');
}

async function personOf(sipId: string): Promise<Person> {
  const [p] = await db
    .select({ sipId: employees.sipId, name: employeeNameSql, department: departments.name, dateOfJoining: employees.dateOfJoining })
    .from(employees)
    .leftJoin(departments, eq(employees.departmentId, departments.id))
    .where(eq(employees.sipId, sipId));
  if (!p) throw new NotFoundError('Employee not found');
  return p;
}

export async function attendanceRoutes(app: FastifyInstance): Promise<void> {
  const manage = { preHandler: requirePermission('attendance.manage') };

  app.get('/', async (req) => {
    const q = z
      .object({ month: month.default(todayISO().slice(0, 7)), department: z.coerce.number().int().positive().optional(), q: z.string().trim().max(100).optional() })
      .parse(req.query);
    const { start, end } = monthBounds(q.month);
    const where = and(
      scope(req.auth),
      ne(employees.status, 'inactive'),
      lte(employees.dateOfJoining, end),
      q.department ? eq(employees.departmentId, q.department) : undefined,
      q.q ? or(ilike(employeeNameSql, `%${q.q}%`), ilike(employees.sipId, `%${q.q}%`)) : undefined,
    );
    const people = await db
      .select({ sipId: employees.sipId, name: employeeNameSql, department: departments.name, dateOfJoining: employees.dateOfJoining })
      .from(employees)
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .where(where)
      .orderBy(employeeNameSql);
    const days = await buildDays(db, people, start, end);
    const settings = await getSetting(db, 'attendance');
    const [{ lastSync }] = await db.select({ lastSync: sql<string | null>`max(${attendanceDays.updatedAt})` }).from(attendanceDays).where(ne(attendanceDays.source, 'manual'));
    return {
      month: q.month,
      settings,
      today: shiftDayOf(new Date(), settings as AttendanceSettings),
      lastSync,
      labels: STATUS_LABEL,
      data: people.map((p) => {
        const d = days.get(p.sipId) ?? [];
        return { ...p, totals: totalsOf(d), days: d };
      }),
    };
  });

  app.get('/people/:sipId', async (req) => {
    const { sipId } = z.object({ sipId: z.string().min(1) }).parse(req.params);
    const q = z.object({ month: month.default(todayISO().slice(0, 7)) }).parse(req.query);
    if (sipId !== req.auth.sipId && !can(req.auth, 'attendance.view')) {
      if (!can(req.auth, 'team.view')) throw new ForbiddenError('Missing permission: attendance.view');
      await assertCanReadEmployee(req.auth, sipId);
    }
    const p = await personOf(sipId);
    const { start, end } = monthBounds(q.month);
    const days = (await buildDays(db, [p], start, end)).get(sipId) ?? [];
    const settings = await getSetting(db, 'attendance');
    return { month: q.month, person: p, settings, today: shiftDayOf(new Date(), settings as AttendanceSettings), totals: totalsOf(days), days };
  });

  app.put('/people/:sipId/:day', manage, async (req) => {
    const { sipId, day } = z.object({ sipId: z.string().min(1), day: z.string().refine(isISODate, 'Date is YYYY-MM-DD') }).parse(req.params);
    const body = z.object({ status: z.enum(MANUAL_STATUSES), note: z.string().trim().max(300).nullable().optional() }).parse(req.body);
    const p = await personOf(sipId);
    const [before] = await db.select().from(attendanceDays).where(and(eq(attendanceDays.sipId, sipId), eq(attendanceDays.day, day), eq(attendanceDays.source, 'manual')));
    await db
      .insert(attendanceDays)
      .values({ sipId, day, source: 'manual', status: body.status, note: body.note ?? null, createdBy: req.auth.userId })
      .onConflictDoUpdate({
        target: [attendanceDays.companyId, attendanceDays.sipId, attendanceDays.day, attendanceDays.source, attendanceDays.context],
        set: { status: body.status, note: body.note ?? null, createdBy: req.auth.userId, updatedAt: new Date() },
      });
    await writeAudit(db, req, {
      action: 'update',
      entity: 'attendance_day',
      entityId: `${sipId}:${day}`,
      summary: `set ${p.name}'s attendance on ${day} to ${STATUS_LABEL[body.status].toLowerCase()}${body.note ? ` (${body.note})` : ''}`,
      before: before ? { status: before.status, note: before.note } : null,
      after: { sipId, day, status: body.status, note: body.note ?? null },
    });
    return { ok: true };
  });

  app.delete('/people/:sipId/:day', manage, async (req) => {
    const { sipId, day } = z.object({ sipId: z.string().min(1), day: z.string().refine(isISODate, 'Date is YYYY-MM-DD') }).parse(req.params);
    const p = await personOf(sipId);
    const gone = await db
      .delete(attendanceDays)
      .where(and(eq(attendanceDays.sipId, sipId), eq(attendanceDays.day, day), eq(attendanceDays.source, 'manual')))
      .returning();
    if (gone.length) {
      await writeAudit(db, req, {
        action: 'update',
        entity: 'attendance_day',
        entityId: `${sipId}:${day}`,
        summary: `handed ${p.name}'s attendance on ${day} back to the dialer`,
        before: { status: gone[0].status, note: gone[0].note },
        after: null,
      });
    }
    return { ok: true };
  });

  app.get('/settings', async () => getSetting(db, 'attendance'));

  app.put('/settings', manage, async (req) => {
    const body = settingsSchema.parse(req.body);
    const before = await getSetting(db, 'attendance');
    await setSetting(db, 'attendance', body, req.auth.userId);
    await writeAudit(db, req, { action: 'update', entity: 'settings', entityId: 'attendance', summary: 'changed the attendance rules', before, after: body });
    return body;
  });
}
