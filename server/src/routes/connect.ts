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
 *   POST   /connect/:system/sales                     report sales (closer and fronter credit)
 *   GET    /connect/:system/attendance/settings       how shift days are cut (time zone, boundary)
 *   POST   /connect/:system/attendance                report dialer activity per person and shift day
 *   GET    /connect/employees/:sipId                  one person's accounts and figures
 *
 * All of it is company-scoped like every other route; an API key sees only
 * its own company's people.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '../db/client.js';
import { attendanceDays, departments, designations, employeeLinks, employeeMetrics, employees, leaveApplications, leaveTypes, sales } from '../db/schema.js';
import { assertCanReadEmployee, can, requirePermission } from '../auth/plugin.js';
import { writeAudit } from '../lib/audit.js';
import { addDays, todayISO } from '../lib/dates.js';
import { ValidationError } from '../lib/errors.js';
import { employeeNameSql } from '../services/people.js';
import { closedMonths } from '../services/sales.js';
import { getSetting } from '../services/settings.js';

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

/**
 * The employee behind each account: a link made in HRMS first, otherwise an
 * employee whose SIP ID is the account itself (staff whose SIP ID is their
 * VICIdial user need no link).
 */
async function accountSips(system: string, context: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const links = await db
    .select({ externalId: employeeLinks.externalId, sipId: employeeLinks.sipId })
    .from(employeeLinks)
    .where(and(eq(employeeLinks.system, system), eq(employeeLinks.context, context), inArray(employeeLinks.externalId, ids)));
  for (const l of links) out.set(l.externalId, l.sipId);
  const rest = ids.filter((id) => !out.has(id));
  if (rest.length) {
    const same = await db.select({ sipId: employees.sipId }).from(employees).where(inArray(employees.sipId, rest));
    for (const e of same) out.set(e.sipId, e.sipId);
  }
  return out;
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

    const sipOf = await accountSips(system, q.context, ids);
    const sipList = [...new Set(sipOf.values())];
    const rows = !sipList.length ? [] : await db
      .select({
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
      .from(employees)
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .leftJoin(designations, eq(employees.designationId, designations.id))
      .leftJoin(mgr, eq(employees.managerSipId, mgr.sipId))
      .where(inArray(employees.sipId, sipList));

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

    const bySip = new Map(rows.map((r) => [r.sipId, r]));
    const data = ids.map((id) => {
      const sip = sipOf.get(id);
      const r = sip ? bySip.get(sip) : undefined;
      if (!r) return { externalId: id, context: q.context, found: false as const };
      const mine = leave.filter((l) => l.sipId === r.sipId);
      const todayLeave = mine.find((l) => l.status === 'approved' && l.startDate <= today && l.endDate >= today);
      return {
        externalId: id,
        context: q.context,
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

    // accounts → people, per context (links first, then SIP ID = account)
    const sipOfAccount = new Map<string, string>();
    for (const ctx of new Set(body.items.filter((i) => i.externalId).map((i) => i.context))) {
      const ext = [...new Set(body.items.filter((i) => i.externalId && i.context === ctx).map((i) => i.externalId!))];
      for (const [acc, sip] of await accountSips(system, ctx, ext)) sipOfAccount.set(`${ctx} ${acc}`, sip);
    }
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
        : sipOfAccount.get(`${i.context} ${i.externalId}`) ?? null;
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

  /**
   * Sales from a system, each credited to its closer and (optionally) the
   * fronter whose transfer led to it. Idempotent per (externalRef, role):
   * sending a sale again updates it. With `window`, this system's sales in
   * that date range that are not in `items` are voided (the sale was undone
   * in the source). A sale a person voided by hand stays voided. Months with
   * approved or paid payroll are never changed.
   *
   * `closer` and `fronter` may be one account or a list of candidates (a
   * person with several dialer users): the first that belongs to an employee
   * counts. `accounts` says which system those ids belong to when it is not
   * the sender, e.g. a CRM sending VICIdial users: { system: 'vicidial' }.
   */
  app.post('/:system/sales', { preHandler: requirePermission('sales.write') }, async (req) => {
    const { system } = systemParam.parse(req.params);
    const isoDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Dates are YYYY-MM-DD');
    const body = z
      .object({
        context: contextStr,
        window: z.object({ from: isoDate, to: isoDate }).optional(),
        accounts: z.object({ system: systemParam.shape.system, context: contextStr }).optional(),
        items: z
          .array(
            z
              .object({
                externalRef: z.string().trim().min(1).max(100),
                saleDate: isoDate,
                closer: z.union([externalId, z.array(externalId).min(1).max(10)]).optional(),
                fronter: z.union([externalId, z.array(externalId).min(1).max(10)]).optional(),
                closerSipId: z.string().trim().min(1).optional(),
                fronterSipId: z.string().trim().min(1).optional(),
                reference: z.string().trim().max(120).optional().nullable(),
                amount: z.number().int().min(0).max(1_000_000_000).optional().nullable(),
              })
              .refine((i) => i.closer || i.closerSipId || i.fronter || i.fronterSipId, 'Each sale needs a closer or a fronter'),
          )
          .max(2000),
      })
      .parse(req.body);
    const w = body.window;
    if (w) {
      if (w.from > w.to) throw new ValidationError('window.from is after window.to');
      if ((Date.parse(w.to) - Date.parse(w.from)) / 86_400_000 > 62) throw new ValidationError('A window covers at most 62 days');
      const outside = body.items.find((i) => i.saleDate < w.from || i.saleDate > w.to);
      if (outside) throw new ValidationError(`Sale ${outside.externalRef} (${outside.saleDate}) is outside the window`);
    }
    const ctx = body.context;
    const closed = await closedMonths(db);
    const isClosed = (d: string) => closed.has(d.slice(0, 7));

    // accounts → people (candidates in order; the first that is an employee counts)
    const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    const accounts = [...new Set(body.items.flatMap((i) => [...list(i.closer), ...list(i.fronter)]))];
    const sipOfAccount = await accountSips(body.accounts?.system ?? system, body.accounts ? body.accounts.context : ctx, accounts);
    const sipsGiven = [...new Set(body.items.flatMap((i) => [i.closerSipId, i.fronterSipId]).filter((x): x is string => !!x))];
    const knownSips = new Set(
      sipsGiven.length ? (await db.select({ sipId: employees.sipId }).from(employees).where(inArray(employees.sipId, sipsGiven))).map((e) => e.sipId) : [],
    );

    type Want = { key: string; externalRef: string; role: 'closer' | 'fronter'; sipId: string; saleDate: string; externalUser: string | null; reference: string | null; amount: number | null };
    const wanted = new Map<string, Want>();
    const unknown = new Set<string>();
    let locked = 0;
    for (const i of body.items) {
      for (const r of ['closer', 'fronter'] as const) {
        const candidates = list(i[r]);
        const given = r === 'closer' ? i.closerSipId : i.fronterSipId;
        if (!candidates.length && !given) continue;
        const account = given ? undefined : candidates.find((c) => sipOfAccount.has(c)) ?? candidates[0];
        const sipId = given ? (knownSips.has(given) ? given : null) : sipOfAccount.get(account!) ?? null;
        if (!sipId) {
          unknown.add(given ?? candidates.join('|'));
          continue;
        }
        if (isClosed(i.saleDate)) {
          locked++;
          continue;
        }
        const key = `${i.externalRef}\u0000${r}`;
        wanted.set(key, {
          key,
          externalRef: i.externalRef,
          role: r,
          sipId,
          saleDate: i.saleDate,
          externalUser: account ?? null,
          reference: i.reference ?? null,
          amount: r === 'closer' ? (i.amount ?? null) : null,
        });
      }
    }

    // what is stored already: these refs, plus everything in the window
    const refs = [...new Set(body.items.map((i) => i.externalRef))];
    const existing = await db
      .select()
      .from(sales)
      .where(
        and(
          eq(sales.source, system),
          eq(sales.context, ctx),
          w
            ? or(refs.length ? inArray(sales.externalRef, refs) : undefined, and(gte(sales.saleDate, w.from), lte(sales.saleDate, w.to)))
            : inArray(sales.externalRef, refs.length ? refs : ['\u0000']),
        ),
      );
    const stored = new Map(existing.map((e) => [`${e.externalRef}\u0000${e.role}`, e]));

    const inserts: Want[] = [];
    let updated = 0;
    let unchanged = 0;
    for (const want of wanted.values()) {
      const cur = stored.get(want.key);
      if (!cur) {
        inserts.push(want);
        continue;
      }
      if (isClosed(cur.saleDate)) {
        locked++;
        continue;
      }
      const revive = cur.status === 'void' && cur.voidedBy === null;
      const same =
        cur.sipId === want.sipId &&
        cur.saleDate === want.saleDate &&
        cur.externalUser === want.externalUser &&
        cur.reference === want.reference &&
        cur.amount === want.amount;
      if (same && !revive) {
        unchanged++;
        continue;
      }
      await db
        .update(sales)
        .set({
          sipId: want.sipId,
          saleDate: want.saleDate,
          externalUser: want.externalUser,
          reference: want.reference,
          amount: want.amount,
          ...(revive ? { status: 'confirmed', voidReason: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(sales.id, cur.id));
      updated++;
    }
    for (let i = 0; i < inserts.length; i += 500) {
      await db.insert(sales).values(
        inserts.slice(i, i + 500).map((x) => ({
          sipId: x.sipId,
          role: x.role,
          saleDate: x.saleDate,
          source: system,
          context: ctx,
          externalRef: x.externalRef,
          externalUser: x.externalUser,
          reference: x.reference,
          amount: x.amount,
        })),
      );
    }

    // undone in the source: confirmed rows in the window that were not sent
    let voided = 0;
    if (w) {
      const sentKeys = new Set(body.items.flatMap((i) => [`${i.externalRef}\u0000closer`, `${i.externalRef}\u0000fronter`]));
      const gone = existing.filter(
        (e) =>
          e.status === 'confirmed' &&
          e.saleDate >= w.from &&
          e.saleDate <= w.to &&
          !isClosed(e.saleDate) &&
          !(sentKeys.has(`${e.externalRef}\u0000${e.role}`) && wanted.has(`${e.externalRef}\u0000${e.role}`)),
      );
      if (gone.length) {
        await db
          .update(sales)
          .set({ status: 'void', voidReason: `No longer a sale in ${label(system)}`, updatedAt: new Date() })
          .where(inArray(sales.id, gone.map((g) => g.id)));
        voided = gone.length;
      }
    }

    if (inserts.length || updated || voided) {
      const parts = [inserts.length && `${inserts.length} new`, updated && `${updated} updated`, voided && `${voided} voided`].filter(Boolean).join(', ');
      await writeAudit(db, req, {
        action: 'received',
        entity: 'sale',
        entityId: system,
        summary: `received sales from ${label(system)}: ${parts}`,
        after: { system, context: ctx, window: w ?? null, inserted: inserts.length, updated, voided },
      });
    }
    return { system, received: body.items.length, inserted: inserts.length, updated, unchanged, voided, locked, unknown: [...unknown] };
  });

  /** One person's accounts in other systems and their latest figures (for the profile). */
  /** How a reporting system must cut shift days, so both sides agree on what "a day" is. */
  app.get('/:system/attendance/settings', { preHandler: requirePermission('attendance.write', 'attendance.view') }, async () => {
    const s = await getSetting(db, 'attendance');
    return { timeZone: s.timeZone, dayStartsAt: s.dayStartsAt };
  });

  /**
   * Dialer activity per person and shift day: first call, last call, calls,
   * talk time. The window is replaced: this system's days in it that are not
   * in `items` are removed (the activity is gone at the source). Several
   * accounts of one person on one day are merged. Days HR set by hand are
   * never touched; they simply win when the day is shown.
   */
  app.post('/:system/attendance', { preHandler: requirePermission('attendance.write') }, async (req) => {
    const { system } = systemParam.parse(req.params);
    const isoDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Dates are YYYY-MM-DD');
    const account =z.union([externalId, z.array(externalId).min(1).max(10)]);
    const body = z
      .object({
        context: contextStr,
        accounts: z.object({ system: systemParam.shape.system, context: contextStr }).optional(),
        window: z.object({ from: isoDate, to: isoDate }),
        items: z
          .array(
            z.object({
              account,
              day: isoDate,
              firstAt: z.string().datetime({ offset: true }),
              lastAt: z.string().datetime({ offset: true }),
              calls: z.number().int().min(0).max(100_000),
              talkSec: z.number().int().min(0).max(86_400 * 2),
            }),
          )
          .max(5000),
      })
      .parse(req.body);
    const w = body.window;
    if (w.from > w.to) throw new ValidationError('window.from is after window.to');
    if ((Date.parse(w.to) - Date.parse(w.from)) / 86_400_000 > 62) throw new ValidationError('A window covers at most 62 days');
    const outside = body.items.find((i) => i.day < w.from || i.day > w.to);
    if (outside) throw new ValidationError(`A day (${outside.day}) is outside the window`);
    if (system === 'manual') throw new ValidationError("'manual' is reserved for days HR sets by hand");
    const ctx = body.context;

    const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);
    const accounts = [...new Set(body.items.flatMap((i) => list(i.account)))];
    const sipOf = await accountSips(body.accounts?.system ?? system, body.accounts ? body.accounts.context : ctx, accounts);

    type Want = { sipId: string; day: string; firstAt: Date; lastAt: Date; calls: number; talkSec: number; accounts: Set<string> };
    const wanted = new Map<string, Want>();
    const unknown = new Set<string>();
    for (const i of body.items) {
      const cands = list(i.account);
      const acc = cands.find((c) => sipOf.has(c));
      if (!acc) {
        unknown.add(cands.join('|'));
        continue;
      }
      const sipId = sipOf.get(acc)!;
      const k = `${sipId} ${i.day}`;
      const first = new Date(i.firstAt);
      const last = new Date(i.lastAt);
      const cur = wanted.get(k);
      if (!cur) {
        wanted.set(k, { sipId, day: i.day, firstAt: first, lastAt: last < first ? first : last, calls: i.calls, talkSec: i.talkSec, accounts: new Set([acc]) });
      } else {
        if (first < cur.firstAt) cur.firstAt = first;
        if (last > cur.lastAt) cur.lastAt = last;
        cur.calls += i.calls;
        cur.talkSec += i.talkSec;
        cur.accounts.add(acc);
      }
    }

    const existing = await db
      .select()
      .from(attendanceDays)
      .where(and(eq(attendanceDays.source, system), eq(attendanceDays.context, ctx), gte(attendanceDays.day, w.from), lte(attendanceDays.day, w.to)));
    const stored = new Map(existing.map((e) => [`${e.sipId} ${e.day}`, e]));
    let saved = 0;
    let unchanged = 0;
    for (const [k, v] of wanted) {
      const cur = stored.get(k);
      const accs = [...v.accounts].sort().join(',');
      if (
        cur &&
        cur.firstAt?.getTime() === v.firstAt.getTime() &&
        cur.lastAt?.getTime() === v.lastAt.getTime() &&
        cur.calls === v.calls &&
        cur.talkSec === v.talkSec &&
        cur.accounts === accs
      ) {
        unchanged++;
        continue;
      }
      await db
        .insert(attendanceDays)
        .values({ sipId: v.sipId, day: v.day, source: system, context: ctx, firstAt: v.firstAt, lastAt: v.lastAt, calls: v.calls, talkSec: v.talkSec, accounts: accs })
        .onConflictDoUpdate({
          target: [attendanceDays.companyId, attendanceDays.sipId, attendanceDays.day, attendanceDays.source, attendanceDays.context],
          set: { firstAt: v.firstAt, lastAt: v.lastAt, calls: v.calls, talkSec: v.talkSec, accounts: accs, updatedAt: new Date() },
        });
      saved++;
    }
    const gone = existing.filter((e) => !wanted.has(`${e.sipId} ${e.day}`)).map((e) => e.id);
    if (gone.length) await db.delete(attendanceDays).where(inArray(attendanceDays.id, gone));

    if (saved || gone.length) {
      await writeAudit(db, req, {
        action: 'update',
        entity: 'attendance_day',
        entityId: system,
        summary: `received attendance from ${label(system)} for ${w.from} to ${w.to}: ${saved} day${saved === 1 ? '' : 's'} updated${gone.length ? `, ${gone.length} removed` : ''}`,
        after: { system, window: w, saved, removed: gone.length },
      });
    }
    return { system, received: body.items.length, saved, unchanged, removed: gone.length, locked: 0, unknown: [...unknown] };
  });

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
