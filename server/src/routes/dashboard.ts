/**
 * The dashboard reads straight from every module's tables. Each block is
 * returned only when the caller may see that module; otherwise it is null.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  applications,
  auditTrail,
  employees,
  leaveApplications,
  leaveTypes,
  payrollRuns,
  payslipLines,
  payslips,
  users,
  type PipelineStage,
} from '../db/schema.js';
import { can, requirePermission } from '../auth/plugin.js';
import { addDays, monthBounds, todayISO } from '../lib/dates.js';
import { balanceOf } from '../services/leaveLedger.js';
import { activationBlockers } from '../services/employees.js';
import { employeeNameSql } from '../services/people.js';
import { auditScope } from '../lib/auditAccess.js';

const OPEN_STAGES: PipelineStage[] = [
  'application_received',
  'screening',
  'interview_scheduled',
  'interview_completed',
  'feedback_received',
  'offer_made',
  'offer_accepted',
];

/** applications of candidates that were not soft-deleted */
const liveCandidate = sql`exists (select 1 from candidates c where c.id = ${applications.candidateId} and c.deleted_at is null)`;

function prevMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
}

/** Leave the caller may decide: everyone's with leave.approve, direct reports' with leave.approve.team. */
function leaveScope(req: FastifyRequest) {
  if (can(req.auth, 'leave.approve')) return { ok: true as const, where: undefined };
  if (can(req.auth, 'leave.approve.team') && req.auth.sipId) {
    return {
      ok: true as const,
      where: sql`${leaveApplications.sipId} in (select ${employees.sipId} from ${employees} where ${employees.managerSipId} = ${req.auth.sipId})`,
    };
  }
  return { ok: false as const, where: undefined };
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  /** Sidebar counts. Each is 0 when the caller can't see that module. */
  app.get('/counts', async (req) => {
    const out = { pipeline: 0, documents: 0, leave: 0 };
    if (can(req.auth, 'recruitment.view')) {
      const [r] = await db
        .select({ n: count() })
        .from(applications)
        .where(and(inArray(applications.currentStage, OPEN_STAGES), sql`${applications.status} <> 'rejected'`, liveCandidate));
      out.pipeline = r.n;
    }
    if (can(req.auth, 'employees.view') || can(req.auth, 'documents.manage')) {
      const [r] = await db.select({ n: count() }).from(employees).where(eq(employees.status, 'pending'));
      out.documents = r.n;
    }
    const scope = leaveScope(req);
    if (scope.ok) {
      const [r] = await db
        .select({ n: count() })
        .from(leaveApplications)
        .where(and(eq(leaveApplications.status, 'pending'), scope.where, req.auth.sipId ? sql`${leaveApplications.sipId} <> ${req.auth.sipId}` : undefined));
      out.leave = r.n;
    }
    return out;
  });

  app.get('/', { preHandler: requirePermission('dashboard.view') }, async (req) => {
    const today = todayISO();
    const month = today.slice(0, 7);
    const { start: monthStart } = monthBounds(month);
    const { start: lastStart, end: lastEnd } = monthBounds(prevMonth(month));

    const seePeople = can(req.auth, 'employees.view');
    const seeLeave = can(req.auth, 'leave.view') || can(req.auth, 'leave.approve') || can(req.auth, 'leave.approve.team');
    const seeRecruit = can(req.auth, 'recruitment.view');
    const seePayroll = can(req.auth, 'payroll.view');

    /* ---- headline numbers ---- */
    let people = null;
    if (seePeople) {
      const [r] = await db
        .select({
          active: sql<number>`count(*) filter (where ${employees.status} = 'active')::int`,
          pending: sql<number>`count(*) filter (where ${employees.status} = 'pending')::int`,
          joined: sql<number>`count(*) filter (where ${employees.dateOfJoining} >= ${monthStart} and ${employees.dateOfJoining} <= ${today})::int`,
          left: sql<number>`count(*) filter (where ${employees.deactivatedAt} >= ${monthStart}::date)::int`,
        })
        .from(employees);
      people = { active: r.active, pending: r.pending, joinedThisMonth: r.joined, leftThisMonth: r.left };
    }

    let leave = null;
    if (seeLeave) {
      const scope = leaveScope(req);
      const onLeave = await db
        .select({ unpaid: leaveApplications.unpaidDays })
        .from(leaveApplications)
        .where(
          and(
            eq(leaveApplications.status, 'approved'),
            lte(leaveApplications.startDate, today),
            gte(leaveApplications.endDate, today),
            // leave.view sees everyone; a team approver only their reports
            can(req.auth, 'leave.view') ? undefined : scope.where,
          ),
        );
      const [pend] = await db
        .select({ n: count(), oldest: sql<string | null>`min(${leaveApplications.createdAt})` })
        .from(leaveApplications)
        .where(and(eq(leaveApplications.status, 'pending'), scope.where));

      // the approver's queue, five oldest first
      let queue: Array<Record<string, unknown>> = [];
      if (scope.ok) {
        const rows = await db
          .select({
            id: leaveApplications.id,
            sipId: leaveApplications.sipId,
            name: employeeNameSql,
            department: sql<string | null>`(select name from departments d where d.id = ${employees.departmentId})`,
            type: leaveTypes.name,
            leaveTypeId: leaveApplications.leaveTypeId,
            isPaid: leaveTypes.isPaid,
            startDate: leaveApplications.startDate,
            endDate: leaveApplications.endDate,
            totalDays: leaveApplications.totalDays,
            unpaidDays: leaveApplications.unpaidDays,
            createdAt: leaveApplications.createdAt,
          })
          .from(leaveApplications)
          .innerJoin(employees, eq(leaveApplications.sipId, employees.sipId))
          .innerJoin(leaveTypes, eq(leaveApplications.leaveTypeId, leaveTypes.id))
          .where(
            and(
              eq(leaveApplications.status, 'pending'),
              scope.where,
              req.auth.sipId ? sql`${leaveApplications.sipId} <> ${req.auth.sipId}` : undefined,
            ),
          )
          .orderBy(asc(leaveApplications.createdAt))
          .limit(5);
        queue = await Promise.all(
          rows.map(async (r) => ({
            ...r,
            balanceAfter: r.isPaid ? Math.max(0, (await balanceOf(db, r.sipId, r.leaveTypeId)) - (r.totalDays - r.unpaidDays)) : null,
          })),
        );
      }
      leave = {
        onLeaveToday: onLeave.length,
        onLeaveTodayUnpaid: onLeave.filter((x) => x.unpaid > 0).length,
        pending: pend.n,
        oldestPendingAt: pend.oldest,
        canDecide: scope.ok,
        queue,
      };
    }

    /* ---- recruitment ---- */
    let recruitment = null;
    if (seeRecruit) {
      const byStage = await db
        .select({ stage: applications.currentStage, n: count() })
        .from(applications)
        .where(and(inArray(applications.currentStage, OPEN_STAGES), sql`${applications.status} <> 'rejected'`, liveCandidate))
        .groupBy(applications.currentStage);
      const [thisMonth] = await db.select({ n: count() }).from(applications).where(gte(applications.applicationDate, monthStart));
      const [lastMonth] = await db
        .select({ n: count() })
        .from(applications)
        .where(and(gte(applications.applicationDate, lastStart), lte(applications.applicationDate, lastEnd)));
      const hired = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from stage_history where to_stage = 'hired' and created_at >= ${monthStart}::date`,
      );
      const stageCount = new Map(byStage.map((s) => [s.stage, s.n]));
      recruitment = {
        stages: OPEN_STAGES.map((s) => ({ stage: s, count: stageCount.get(s) ?? 0 })),
        open: byStage.reduce((n, s) => n + s.n, 0),
        appliedThisMonth: thisMonth.n,
        appliedLastMonth: lastMonth.n,
        hiredThisMonth: hired.rows[0]?.n ?? 0,
      };
    }

    /* ---- payroll ---- */
    let payroll = null;
    if (seePayroll) {
      const runs = await db
        .select({
          id: payrollRuns.id,
          periodMonth: payrollRuns.periodMonth,
          status: payrollRuns.status,
          net: sql<number>`coalesce(sum(${payslips.netTotal}), 0)::int`,
          a: sql<number>`coalesce(sum(${payslips.grossA}), 0)::int`,
          b: sql<number>`coalesce(sum(${payslips.totalAdditionsB}), 0)::int`,
          c: sql<number>`coalesce(sum(${payslips.totalDeductionsC}), 0)::int`,
          headcount: sql<number>`count(${payslips.id})::int`,
          prorated: sql<number>`count(*) filter (where ${payslips.notJoinedDays} > 0)::int`,
          increments: sql<number>`count(*) filter (where ${payslips.newSalaryDays} > 0)::int`,
        })
        .from(payrollRuns)
        .leftJoin(payslips, eq(payslips.runId, payrollRuns.id))
        .groupBy(payrollRuns.id)
        .orderBy(desc(payrollRuns.periodMonth))
        .limit(12);
      const latest = runs[0] ?? null;
      let lines: Array<{ section: string; component: string; amount: number }> = [];
      if (latest) {
        lines = await db
          .select({
            section: payslipLines.section,
            component: payslipLines.component,
            amount: sql<number>`sum(${payslipLines.amount})::int`,
          })
          .from(payslipLines)
          .innerJoin(payslips, eq(payslipLines.payslipId, payslips.id))
          .where(eq(payslips.runId, latest.id))
          .groupBy(payslipLines.section, payslipLines.component)
          .orderBy(payslipLines.section, desc(sql`sum(${payslipLines.amount})`));
      }
      payroll = {
        history: [...runs].reverse().map((r) => ({ periodMonth: r.periodMonth, net: r.net, status: r.status })),
        latest: latest && {
          ...latest,
          sections: (['A', 'B', 'C'] as const).map((s) => {
            const ls = lines.filter((l) => l.section === s);
            // top four components, the rest folded into "Other"
            const top = ls.slice(0, 4);
            const rest = ls.slice(4).reduce((n, l) => n + l.amount, 0);
            return { section: s, lines: rest > 0 ? [...top, { section: s, component: 'Other', amount: rest }] : top };
          }),
        },
      };
    }

    /* ---- employees blocked from going active ---- */
    let blocked = null;
    if (seePeople) {
      const pend = await db
        .select({ sipId: employees.sipId, name: employeeNameSql, dateOfJoining: employees.dateOfJoining })
        .from(employees)
        .where(eq(employees.status, 'pending'))
        .orderBy(asc(employees.dateOfJoining))
        .limit(5);
      blocked = await Promise.all(pend.map(async (p) => ({ ...p, missing: await activationBlockers(db, p.sipId) })));
    }

    /* ---- recent activity (audit rows with a readable summary) ---- */
    let activity = null;
    if (can(req.auth, 'audit.view') || seePeople) {
      activity = await db
        .select({
          id: auditTrail.id,
          who: sql<string | null>`coalesce(${users.name}, case when ${auditTrail.userId} is not null then 'Super admin' end)`,
          summary: auditTrail.summary,
          entity: auditTrail.entity,
          entityId: auditTrail.entityId,
          createdAt: auditTrail.createdAt,
        })
        .from(auditTrail)
        .leftJoin(users, eq(auditTrail.userId, users.id))
        .where(
          and(
            isNotNull(auditTrail.summary),
            notInArray(auditTrail.action, ['login', 'change_password', 'reset_password', 'switch_company']),
            // only activity from modules the reader can open (no salary changes for a recruiter)
            auditScope(req.auth),
          ),
        )
        .orderBy(desc(auditTrail.id))
        .limit(8);
    }

    return {
      today,
      upcomingLeaveFrom: today,
      upcomingLeaveTo: addDays(today, 14),
      people,
      leave,
      recruitment,
      payroll,
      blocked,
      activity,
    };
  });
}
