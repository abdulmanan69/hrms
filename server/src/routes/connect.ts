/**
 * Connector API for other systems that know people by their own account ids,
 * e.g. VICIdial (agent user names). Mounted at /api/v1/connect.
 *
 *   GET    /connect/:system/people?ids=a,b&context=   people behind those accounts
 *   GET    /connect/:system/roster                    everyone, with their accounts
 *   POST   /connect/:system/suggest                   name matches for unlinked accounts
 *   PUT    /connect/:system/links                     link accounts to employees (bulk)
 *   DELETE /connect/:system/links                     unlink one account
 *   POST   /connect/:system/metrics                   report figures per account
 *   GET    /connect/employees/:sipId                  one person's accounts and figures
 *
 * All of it is company-scoped like every other route; an API key sees only
 * its own company's people.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '../db/client.js';
import { departments, designations, employeeLinks, employeeMetrics, employees, leaveApplications, leaveTypes } from '../db/schema.js';
import { assertCanReadEmployee, can, requirePermission } from '../auth/plugin.js';
import { writeAudit } from '../lib/audit.js';
import { addDays, todayISO } from '../lib/dates.js';
import { ValidationError } from '../lib/errors.js';
import { employeeNameSql } from '../services/people.js';

const systemParam = z.object({ system: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/, 'System names are lowercase, e.g. vicidial') });
const externalId = z.string().trim().min(1).max(100);
const contextStr = z.string().trim().max(100).default('');

const SYSTEM_LABEL: Record<string, string> = { vicidial: 'VICIdial' };
const label = (s: string) => SYSTEM_LABEL[s] ?? s;

/** lowercase letters only, split into words: "Hira S. Qureshi" → ["hira","s","qureshi"] */
function words(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** 0…1: how well two names match, ignoring order, initials and punctuation. */
function nameScore(a: string, b: string): number {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  const common = [...A].filter((w) => B.has(w)).length;
  return common / Math.max(A.size, B.size);
}

export async function connectRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: requirePermission('employees.view') };
  const manage = { preHandler: requirePermission('employees.manage') };

  const mgr = alias(employees, 'mgr');

  /** People behind a list of external accounts, in the order asked. */
  app.get('/:system/people', read, async (req) => {
    const { system } = systemParam.parse(req.params);
    const q = z.object({ ids: z.string().min(1), context: contextStr }).parse(req.query);
    const ids = [...new Set(q.ids.split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length > 500) throw new ValidationError('Ask for at most 500 accounts at a time');

    const rows = await db
      .select({
        externalId: employeeLinks.externalId,
        context: employeeLinks.context,
        sipId: employees.sipId,
        name: employeeNameSql,
        firstName: employees.firstName,
        lastName: employees.lastName,
        email: employees.email,
        status: employees.status,
        employmentStatus: employees.employmentStatus,
        dateOfJoining: employees.dateOfJoining,
        deactivatedAt: employees.deactivatedAt,
        department: departments.name,
        designation: designations.title,
        managerSipId: employees.managerSipId,
        managerName: sql<string | null>`case when ${mgr.sipId} is null then null else trim(${mgr.firstName} || ' ' || ${mgr.lastName}) end`,
      })
      .from(employeeLinks)
      .innerJoin(employees, eq(employeeLinks.sipId, employees.sipId))
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .leftJoin(designations, eq(employees.designationId, designations.id))
      .leftJoin(mgr, eq(employees.managerSipId, mgr.sipId))
      .where(and(eq(employeeLinks.system, system), eq(employeeLinks.context, q.context), inArray(employeeLinks.externalId, ids)));

    // managers' own accounts in this system, so a dialer can find the team lead too
    const managerSips = [...new Set(rows.map((r) => r.managerSipId).filter((x): x is string => !!x))];
    const managerLinks = managerSips.length
      ? await db
          .select({ sipId: employeeLinks.sipId, externalId: employeeLinks.externalId })
          .from(employeeLinks)
          .where(and(eq(employeeLinks.system, system), eq(employeeLinks.context, q.context), inArray(employeeLinks.sipId, managerSips)))
      : [];

    // leave: today and the next 30 days, approved or waiting (only for callers who may see leave)
    const showLeave = can(req.auth, 'leave.view') || can(req.auth, 'leave.approve');
    const today = todayISO();
    const leave = showLeave && rows.length
      ? await db
          .select({
            sipId: leaveApplications.sipId,
            startDate: leaveApplications.startDate,
            endDate: leaveApplications.endDate,
            totalDays: leaveApplications.totalDays,
            status: leaveApplications.status,
            type: leaveTypes.name,
          })
          .from(leaveApplications)
          .innerJoin(leaveTypes, eq(leaveApplications.leaveTypeId, leaveTypes.id))
          .where(
            and(
              inArray(leaveApplications.sipId, rows.map((r) => r.sipId)),
              inArray(leaveApplications.status, ['approved', 'pending']),
              gte(leaveApplications.endDate, today),
              lte(leaveApplications.startDate, addDays(today, 30)),
            ),
          )
          .orderBy(asc(leaveApplications.startDate))
      : [];

    const byId = new Map(rows.map((r) => [r.externalId, r]));
    const data = ids.map((id) => {
      const r = byId.get(id);
      if (!r) return { externalId: id, context: q.context, found: false as const };
      const mine = leave.filter((l) => l.sipId === r.sipId);
      const todayLeave = mine.find((l) => l.status === 'approved' && l.startDate <= today && l.endDate >= today);
      return {
        externalId: id,
        context: r.context,
        found: true as const,
        employee: {
          sipId: r.sipId,
          name: r.name,
          firstName: r.firstName,
          lastName: r.lastName,
          email: r.email,
          status: r.status,
          active: r.status === 'active',
          employmentStatus: r.employmentStatus,
          department: r.department,
          designation: r.designation,
          dateOfJoining: r.dateOfJoining,
          leftAt: r.status === 'inactive' ? r.deactivatedAt : null,
          manager: r.managerSipId
            ? {
                sipId: r.managerSipId,
                name: r.managerName,
                accounts: managerLinks.filter((m) => m.sipId === r.managerSipId).map((m) => m.externalId),
              }
            : null,
          ...(showLeave
            ? {
                onLeaveToday: !!todayLeave,
                leaveToday: todayLeave ? { type: todayLeave.type, until: todayLeave.endDate } : null,
                upcomingLeave: mine.map((l) => ({ from: l.startDate, to: l.endDate, days: l.totalDays, type: l.type, status: l.status })),
              }
            : {}),
        },
      };
    });
    return { system, data, missing: data.filter((d) => !d.found).map((d) => d.externalId) };
  });

  /** Everyone (active by default) with their accounts in this system: for mapping screens and full syncs. */
  app.get('/:system/roster', read, async (req) => {
    const { system } = systemParam.parse(req.params);
    const q = z.object({ status: z.enum(['active', 'all']).default('active') }).parse(req.query);
    const people = await db
      .select({
        sipId: employees.sipId,
        name: employeeNameSql,
        status: employees.status,
        department: departments.name,
        designation: designations.title,
        managerSipId: employees.managerSipId,
      })
      .from(employees)
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .leftJoin(designations, eq(employees.designationId, designations.id))
      .where(q.status === 'active' ? inArray(employees.status, ['active', 'pending']) : undefined)
      .orderBy(asc(employees.firstName), asc(employees.lastName));
    const links = await db
      .select({ sipId: employeeLinks.sipId, externalId: employeeLinks.externalId, context: employeeLinks.context })
      .from(employeeLinks)
      .where(eq(employeeLinks.system, system));
    return {
      system,
      data: people.map((p) => ({ ...p, accounts: links.filter((l) => l.sipId === p.sipId).map(({ externalId: e, context: c }) => ({ externalId: e, context: c })) })),
      linked: links.length,
    };
  });

  /** For accounts not linked yet, the employees whose names match best. Nothing is saved. */
  app.post('/:system/suggest', read, async (req) => {
    const { system } = systemParam.parse(req.params);
    const body = z
      .object({ accounts: z.array(z.object({ externalId, context: contextStr, fullName: z.string().trim().max(200).default('') })).max(2000) })
      .parse(req.body);
    const people = await db
      .select({ sipId: employees.sipId, name: employeeNameSql, department: departments.name })
      .from(employees)
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .where(inArray(employees.status, ['active', 'pending']));
    const links = await db.select().from(employeeLinks).where(eq(employeeLinks.system, system));
    const linkedSips = new Set(links.map((l) => l.sipId));
    const data = body.accounts.map((a) => {
      const current = links.find((l) => l.externalId === a.externalId && l.context === a.context);
      if (current) return { ...a, linkedTo: current.sipId, suggestions: [] };
      const ranked = people
        .map((p) => ({ ...p, score: Math.round(nameScore(a.fullName, p.name) * 100) / 100, alreadyLinked: linkedSips.has(p.sipId) }))
        .filter((p) => p.score >= 0.5)
        .sort((x, y) => y.score - x.score)
        .slice(0, 3);
      return { ...a, linkedTo: null, suggestions: ranked };
    });
    return { system, data };
  });

  /** Link accounts to employees, many at once. An account already linked elsewhere is moved. */
  app.put('/:system/links', manage, async (req) => {
    const { system } = systemParam.parse(req.params);
    const body = z
      .object({ links: z.array(z.object({ sipId: z.string().trim().min(1), externalId, context: contextStr })).min(1).max(2000) })
      .parse(req.body);
    const sips = [...new Set(body.links.map((l) => l.sipId))];
    const known = new Set((await db.select({ sipId: employees.sipId }).from(employees).where(inArray(employees.sipId, sips))).map((e) => e.sipId));
    const results: Array<{ externalId: string; context: string; sipId: string; ok: boolean; message?: string }> = [];
    let saved = 0;
    for (const l of body.links) {
      if (!known.has(l.sipId)) {
        results.push({ ...l, ok: false, message: `No employee with SIP ID ${l.sipId}` });
        continue;
      }
      await db
        .insert(employeeLinks)
        .values({ sipId: l.sipId, system, externalId: l.externalId, context: l.context, createdBy: req.auth.userId })
        .onConflictDoUpdate({
          target: [employeeLinks.companyId, employeeLinks.system, employeeLinks.context, employeeLinks.externalId],
          set: { sipId: l.sipId, createdBy: req.auth.userId, createdAt: new Date() },
        });
      saved++;
      results.push({ ...l, ok: true });
    }
    if (saved) {
      await writeAudit(db, req, {
        action: 'update',
        entity: 'employee_link',
        entityId: system,
        summary: saved === 1 ? `linked the ${label(system)} account ${body.links[0].externalId} to SIP ${body.links[0].sipId}` : `linked ${saved} ${label(system)} accounts to employees`,
        after: { system, links: body.links.slice(0, 50) },
      });
    }
    return { system, saved, failed: results.filter((r) => !r.ok).length, results };
  });

  app.delete('/:system/links', manage, async (req) => {
    const { system } = systemParam.parse(req.params);
    const body = z.object({ externalId, context: contextStr }).parse(req.body);
    const [gone] = await db
      .delete(employeeLinks)
      .where(and(eq(employeeLinks.system, system), eq(employeeLinks.externalId, body.externalId), eq(employeeLinks.context, body.context)))
      .returning({ sipId: employeeLinks.sipId });
    if (gone) {
      await writeAudit(db, req, {
        action: 'delete',
        entity: 'employee_link',
        entityId: system,
        summary: `unlinked the ${label(system)} account ${body.externalId} from SIP ${gone.sipId}`,
      });
    }
    return { ok: true, removed: !!gone };
  });

  /**
   * Figures per account and period, e.g. a monthly QA score from VICIdial.
   * Sending the same (account, metric, period) again replaces the value.
   */
  app.post('/:system/metrics', { preHandler: requirePermission('metrics.write') }, async (req) => {
    const { system } = systemParam.parse(req.params);
    const body = z
      .object({
        items: z
          .array(
            z
              .object({
                externalId: externalId.optional(),
                sipId: z.string().trim().min(1).optional(),
                context: contextStr,
                metric: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Metric names are lowercase_with_underscores'),
                period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/, 'Period is YYYY-MM or YYYY-MM-DD'),
                value: z.number().finite(),
                unit: z.string().trim().max(20).optional(),
                details: z.record(z.unknown()).optional(),
              })
              .refine((i) => i.externalId || i.sipId, 'Each item needs externalId or sipId'),
          )
          .min(1)
          .max(1000),
      })
      .parse(req.body);

    const ext = [...new Set(body.items.filter((i) => i.externalId).map((i) => i.externalId!))];
    const links = ext.length
      ? await db.select().from(employeeLinks).where(and(eq(employeeLinks.system, system), inArray(employeeLinks.externalId, ext)))
      : [];
    const sipsGiven = [...new Set(body.items.filter((i) => i.sipId).map((i) => i.sipId!))];
    const knownSips = new Set(
      sipsGiven.length ? (await db.select({ sipId: employees.sipId }).from(employees).where(inArray(employees.sipId, sipsGiven))).map((e) => e.sipId) : [],
    );

    let saved = 0;
    const unknown: string[] = [];
    for (const i of body.items) {
      const sipId = i.sipId
        ? knownSips.has(i.sipId)
          ? i.sipId
          : null
        : links.find((l) => l.externalId === i.externalId && l.context === i.context)?.sipId ?? null;
      if (!sipId) {
        unknown.push(i.externalId ?? i.sipId!);
        continue;
      }
      await db
        .insert(employeeMetrics)
        .values({ sipId, source: system, metric: i.metric, period: i.period, value: i.value, unit: i.unit ?? null, details: i.details ?? null })
        .onConflictDoUpdate({
          target: [employeeMetrics.companyId, employeeMetrics.sipId, employeeMetrics.source, employeeMetrics.metric, employeeMetrics.period],
          set: { value: i.value, unit: i.unit ?? null, details: i.details ?? null, updatedAt: new Date() },
        });
      saved++;
    }
    if (saved) {
      const metrics = [...new Set(body.items.map((i) => i.metric))].join(', ');
      await writeAudit(db, req, {
        action: 'received',
        entity: 'employee_metric',
        entityId: system,
        summary: `received ${saved} ${metrics} figure${saved === 1 ? '' : 's'} from ${label(system)}`,
      });
    }
    return { system, saved, unknown: [...new Set(unknown)] };
  });

  /** One person's accounts in other systems and their latest figures (for the profile). */
  app.get('/employees/:sipId', async (req) => {
    const { sipId } = z.object({ sipId: z.string().min(1) }).parse(req.params);
    await assertCanReadEmployee(req.auth, sipId);
    const links = await db
      .select({ system: employeeLinks.system, externalId: employeeLinks.externalId, context: employeeLinks.context, createdAt: employeeLinks.createdAt })
      .from(employeeLinks)
      .where(eq(employeeLinks.sipId, sipId))
      .orderBy(asc(employeeLinks.system), asc(employeeLinks.externalId));
    const metrics = await db
      .select()
      .from(employeeMetrics)
      .where(eq(employeeMetrics.sipId, sipId))
      .orderBy(desc(employeeMetrics.period), asc(employeeMetrics.metric))
      .limit(60);
    return { links, metrics };
  });

}
