/**
 * Recruitment / ATS: candidates, applications and their pipeline, interviews,
 * the communication log and follow-ups, and the hire action that converts a
 * candidate into an employee. Rules live in services/recruitment.ts.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db, type DbOrTx } from '../db/client.js';
import {
  APPLICATION_STATUSES,
  COMM_CHANNELS,
  COMM_DIRECTIONS,
  EMPLOYMENT_STATUSES,
  INTERVIEW_MODES,
  INTERVIEW_OUTCOMES,
  PIPELINE_STAGES,
  applications,
  auditTrail,
  candidates,
  communications,
  departments,
  designations,
  employees,
  interviews,
  roles,
  stageHistory,
  users,
} from '../db/schema.js';
import { can, requirePermission } from '../auth/plugin.js';
import { notify, writeAudit } from '../lib/audit.js';
import { sendCsv, toCsv } from '../lib/csv.js';
import { monthBounds, todayISO } from '../lib/dates.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { offsetOf, pageMeta, paginationSchema } from '../lib/pagination.js';
import { config } from '../config.js';
import { createEmployee } from '../services/employees.js';
import { checkReferences, type EmployeeInput } from '../services/employeeRecords.js';
import { fullName, userIdsWithPermission } from '../services/people.js';
import {
  BOARD_STAGES,
  CLOSED_STATUSES,
  applyStage,
  assertMoveAllowed,
  candidateCode,
  candidateFields,
  cnicSchema,
  findDuplicate,
  optDate,
  parseCandidateCode,
  stageLabel,
} from '../services/recruitment.js';

const owner = alias(users, 'owner');
const idParam = z.object({ id: z.coerce.number().int().positive() });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date YYYY-MM-DD');

const candidateNameSql = sql<string>`trim(${candidates.firstName} || ' ' || coalesce(nullif(${candidates.middleInitial}, '') || '. ', '') || ${candidates.lastName})`;

/** Whole days since the application entered its current stage. */
const daysInStageSql = (today: string) =>
  sql<number>`(${today}::date - (coalesce((select max(sh.created_at) from stage_history sh where sh.application_id = ${applications.id}), ${applications.createdAt}) at time zone ${config.TZ_BUSINESS})::date)::int`;

const openApp = () => notInArray(applications.status, CLOSED_STATUSES);

const applicationFields = {
  positionApplied: z.string().trim().min(1, 'is required').max(120),
  departmentId: z.number().int().positive().nullable().optional(),
  applicationDate: isoDate.optional(),
  priorityRank: z.number().int().min(1).max(999).nullable().optional(),
  ownerRecruiterId: z.number().int().positive().nullable().optional(),
  nextFollowupDate: optDate,
};

const fmtWhen = new Intl.DateTimeFormat('en-GB', { timeZone: config.TZ_BUSINESS, dateStyle: 'medium', timeStyle: 'short' });

/* ------------------------------------------------------------------ */
/* Loaders and checks                                                  */
/* ------------------------------------------------------------------ */

async function loadCandidate(tx: DbOrTx, id: number) {
  const [cand] = await tx.select().from(candidates).where(and(eq(candidates.id, id), isNull(candidates.deletedAt)));
  if (!cand) throw new NotFoundError('Candidate not found');
  return cand;
}

async function loadApplication(tx: DbOrTx, id: number, lock = false) {
  const q = tx.select().from(applications).where(eq(applications.id, id));
  const [app] = lock ? await q.for('update') : await q;
  if (!app) throw new NotFoundError('Application not found');
  const cand = await loadCandidate(tx, app.candidateId);
  return { app, cand };
}

async function assertActiveUsers(tx: DbOrTx, ids: Array<number | null | undefined>): Promise<void> {
  const want = [...new Set(ids.filter((x): x is number => typeof x === 'number'))];
  if (want.length === 0) return;
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, want), eq(users.status, 'active')));
  if (rows.length !== want.length) throw new ValidationError('Pick active users only');
}

async function assertDepartment(tx: DbOrTx, id: number | null | undefined): Promise<void> {
  if (id == null) return;
  const [d] = await tx.select({ id: departments.id }).from(departments).where(eq(departments.id, id));
  if (!d) throw new ValidationError('Department not found');
}

async function userNames(tx: DbOrTx, ids: number[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return new Map();
  const rows = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uniq));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** CNIC is sensitive: only employees.sensitive sees it in full. */
function maskCnic<T extends { cnic: string | null }>(req: FastifyRequest, row: T): T {
  if (!row.cnic || can(req.auth, 'employees.sensitive')) return row;
  return { ...row, cnic: `*****-*******-${row.cnic.slice(-1)}` };
}

/** 409 with the existing candidate, unless the caller passed force: true. */
function duplicateReply(dup: { id: number; name: string; matchedOn: string }) {
  return {
    error: 'duplicate_candidate',
    message: `${dup.name} (${candidateCode(dup.id)}) already has this ${dup.matchedOn}. Open that record, or save anyway.`,
    candidateId: dup.id,
    details: { candidateId: [String(dup.id)], name: [dup.name], matchedOn: [dup.matchedOn] },
  };
}

/* ------------------------------------------------------------------ */
/* Candidate list filters (shared by the table and the CSV export)     */
/* ------------------------------------------------------------------ */

const listQuery = z.object({
  search: z.string().trim().optional(),
  position: z.string().trim().optional(),
  status: z.enum(APPLICATION_STATUSES).optional(),
  stage: z.enum(PIPELINE_STAGES).optional(),
  source: z.string().trim().optional(),
  ownerId: z.coerce.number().int().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const latestAppJoin = sql`${applications.id} = (select max(a2.id) from applications a2 where a2.candidate_id = ${candidates.id})`;

function listWhere(q: z.infer<typeof listQuery>): SQL | undefined {
  const conds: Array<SQL | undefined> = [isNull(candidates.deletedAt)];
  if (q.search) {
    const term = `%${q.search}%`;
    const asId = parseCandidateCode(q.search);
    conds.push(
      or(
        ilike(candidateNameSql, term),
        ilike(candidates.email, term),
        ilike(candidates.phone, term),
        ilike(applications.positionApplied, term),
        asId != null ? eq(candidates.id, asId) : undefined,
      ),
    );
  }
  if (q.position) conds.push(ilike(applications.positionApplied, `%${q.position}%`));
  if (q.status) conds.push(eq(applications.status, q.status));
  if (q.stage) conds.push(eq(applications.currentStage, q.stage));
  if (q.source) conds.push(ilike(candidates.source, `%${q.source}%`));
  if (q.ownerId) conds.push(eq(applications.ownerRecruiterId, q.ownerId));
  if (q.from) conds.push(gte(applications.applicationDate, q.from));
  if (q.to) conds.push(lte(applications.applicationDate, q.to));
  return and(...conds);
}

const listSelect = {
  id: candidates.id,
  firstName: candidates.firstName,
  middleInitial: candidates.middleInitial,
  lastName: candidates.lastName,
  name: candidateNameSql,
  email: candidates.email,
  phone: candidates.phone,
  city: candidates.city,
  country: candidates.country,
  source: candidates.source,
  createdAt: candidates.createdAt,
  applicationId: applications.id,
  positionApplied: applications.positionApplied,
  applicationDate: applications.applicationDate,
  status: applications.status,
  currentStage: applications.currentStage,
  nextFollowupDate: applications.nextFollowupDate,
  hiredSipId: applications.hiredSipId,
  ownerId: owner.id,
  ownerName: owner.name,
  applicationCount: sql<number>`(select count(*)::int from applications a3 where a3.candidate_id = ${candidates.id})`,
};

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export async function recruitmentRoutes(app: FastifyInstance): Promise<void> {
  const view = { preHandler: requirePermission('recruitment.view') };
  const manage = { preHandler: requirePermission('recruitment.manage') };

  /* ---------------- Lookups ---------------- */

  /** Active users for owner and interviewer pickers; recruiters first. */
  app.get('/users', view, async () => {
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        recruiter: sql<boolean>`(${roles.permissions} && array['recruitment.manage', '*']::text[])`,
      })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(eq(users.status, 'active'))
      .orderBy(asc(users.name));
    rows.sort((a, b) => Number(b.recruiter) - Number(a.recruiter));
    return { data: rows };
  });

  /** Distinct positions applied for, for filters and the add form. */
  app.get('/positions', view, async () => {
    const rows = await db
      .selectDistinct({ position: applications.positionApplied })
      .from(applications)
      .orderBy(asc(applications.positionApplied));
    return { data: rows.map((r) => r.position) };
  });

  /* ---------------- Summary (dashboard) ---------------- */

  app.get('/summary', view, async () => {
    const today = todayISO();
    const month = today.slice(0, 7);
    const { start, end } = monthBounds(month);
    const live = and(isNull(candidates.deletedAt));

    const [totals] = await db
      .select({
        candidates: sql<number>`count(distinct ${candidates.id})::int`,
        applications: sql<number>`count(${applications.id})::int`,
        open: sql<number>`count(${applications.id}) filter (where ${applications.status} not in ('rejected','hired'))::int`,
        hired: sql<number>`count(${applications.id}) filter (where ${applications.status} = 'hired')::int`,
        rejected: sql<number>`count(${applications.id}) filter (where ${applications.status} = 'rejected')::int`,
        followupsDue: sql<number>`count(${applications.id}) filter (where ${applications.status} not in ('rejected','hired') and ${applications.nextFollowupDate} <= ${today})::int`,
      })
      .from(candidates)
      .leftJoin(applications, eq(applications.candidateId, candidates.id))
      .where(live);

    const stageRows = await db
      .select({ stage: applications.currentStage, count: sql<number>`count(*)::int` })
      .from(applications)
      .innerJoin(candidates, eq(applications.candidateId, candidates.id))
      .where(and(live, openApp()))
      .groupBy(applications.currentStage);
    const byStageMap = new Map(stageRows.map((r) => [r.stage, r.count]));

    const [hires] = await db
      .select({ n: sql<number>`count(distinct ${stageHistory.applicationId})::int` })
      .from(stageHistory)
      .where(
        and(
          eq(stageHistory.toStage, 'hired'),
          sql`(${stageHistory.createdAt} at time zone ${config.TZ_BUSINESS})::date between ${start} and ${end}`,
        ),
      );

    const [upcoming] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(interviews)
      .where(and(gte(interviews.scheduledAt, new Date()), isNull(interviews.outcome)));

    const recent = await db
      .select({
        id: auditTrail.id,
        at: auditTrail.createdAt,
        userName: users.name,
        summary: auditTrail.summary,
        entity: auditTrail.entity,
        entityId: auditTrail.entityId,
      })
      .from(auditTrail)
      .leftJoin(users, eq(auditTrail.userId, users.id))
      .where(inArray(auditTrail.entity, ['candidate', 'application', 'interview', 'communication']))
      .orderBy(desc(auditTrail.id))
      .limit(10);

    return {
      totals: { ...totals, interviewsUpcoming: upcoming.n },
      byStage: BOARD_STAGES.map((stage) => ({ stage, label: stageLabel(stage), count: byStageMap.get(stage) ?? 0 })),
      hiresThisMonth: hires.n,
      month,
      recent,
    };
  });

  /* ---------------- Pipeline board ---------------- */

  app.get('/pipeline', view, async (req) => {
    const q = z
      .object({ position: z.string().trim().optional(), ownerId: z.coerce.number().int().optional(), search: z.string().trim().optional() })
      .parse(req.query);
    const today = todayISO();
    const conds: Array<SQL | undefined> = [isNull(candidates.deletedAt), openApp()];
    if (q.position) conds.push(eq(applications.positionApplied, q.position));
    if (q.ownerId) conds.push(eq(applications.ownerRecruiterId, q.ownerId));
    if (q.search) {
      const asId = parseCandidateCode(q.search);
      conds.push(
        or(
          ilike(candidateNameSql, `%${q.search}%`),
          ilike(applications.positionApplied, `%${q.search}%`),
          asId != null ? eq(candidates.id, asId) : undefined,
        ),
      );
    }
    const rows = await db
      .select({
        applicationId: applications.id,
        candidateId: candidates.id,
        name: candidateNameSql,
        positionApplied: applications.positionApplied,
        stage: applications.currentStage,
        status: applications.status,
        priorityRank: applications.priorityRank,
        ownerId: owner.id,
        ownerName: owner.name,
        nextFollowupDate: applications.nextFollowupDate,
        daysInStage: daysInStageSql(today),
      })
      .from(applications)
      .innerJoin(candidates, eq(applications.candidateId, candidates.id))
      .leftJoin(owner, eq(applications.ownerRecruiterId, owner.id))
      .where(and(...conds))
      .orderBy(sql`${applications.priorityRank} asc nulls last`, asc(applications.updatedAt));

    const [hired] = await db
      .select({
        total: sql<number>`count(*)::int`,
        thisMonth: sql<number>`count(*) filter (where exists (select 1 from stage_history sh where sh.application_id = ${applications.id} and sh.to_stage = 'hired' and to_char(sh.created_at at time zone ${config.TZ_BUSINESS}, 'YYYY-MM') = ${today.slice(0, 7)}))::int`,
      })
      .from(applications)
      .where(eq(applications.status, 'hired'));

    return {
      today,
      columns: BOARD_STAGES.map((stage) => ({
        stage,
        label: stageLabel(stage),
        items: rows.filter((r) => r.stage === stage),
      })),
      hired,
    };
  });

  /* ---------------- Candidates ---------------- */

  app.get('/candidates', view, async (req) => {
    const q = listQuery.parse(req.query);
    const p = paginationSchema.parse(req.query);
    const where = listWhere(q);
    const rows = await db
      .select(listSelect)
      .from(candidates)
      .leftJoin(applications, latestAppJoin)
      .leftJoin(owner, eq(applications.ownerRecruiterId, owner.id))
      .where(where)
      .orderBy(desc(candidates.id))
      .limit(p.pageSize)
      .offset(offsetOf(p));
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(candidates)
      .leftJoin(applications, latestAppJoin)
      .where(where);
    return { data: rows, meta: pageMeta(p, n) };
  });

  app.get('/candidates/export.csv', view, async (req, reply) => {
    const q = listQuery.parse(req.query);
    const rows = await db
      .select({ ...listSelect, altPhone: candidates.altPhone, postalCode: candidates.postalCode, state: candidates.state })
      .from(candidates)
      .leftJoin(applications, latestAppJoin)
      .leftJoin(owner, eq(applications.ownerRecruiterId, owner.id))
      .where(listWhere(q))
      .orderBy(desc(candidates.id))
      .limit(20000);
    const csv = toCsv(
      ['Candidate ID', 'Name', 'Email', 'Phone', 'Alt phone', 'City', 'State', 'Postal code', 'Country', 'Source', 'Position', 'Applied', 'Stage', 'Status', 'Owner', 'Next follow-up', 'SIP ID'],
      rows.map((r) => [
        candidateCode(r.id),
        r.name,
        r.email,
        r.phone,
        r.altPhone,
        r.city,
        r.state,
        r.postalCode,
        r.country,
        r.source,
        r.positionApplied,
        r.applicationDate,
        r.currentStage ? stageLabel(r.currentStage) : null,
        r.status ? stageLabel(r.status) : null,
        r.ownerName,
        r.nextFollowupDate,
        r.hiredSipId,
      ]),
    );
    return sendCsv(reply, `candidates-${todayISO()}.csv`, csv);
  });

  app.post('/candidates', manage, async (req, reply) => {
    const body = z
      .object({
        ...candidateFields,
        application: z.object(applicationFields),
        force: z.boolean().optional(),
      })
      .parse(req.body);
    if (!body.email && !body.phone) throw new ValidationError('Add an email or a phone number so the candidate can be reached');
    if (!body.force) {
      const dup = await findDuplicate(db, body);
      if (dup) return reply.status(409).send(duplicateReply(dup));
    }
    await assertActiveUsers(db, [body.application.ownerRecruiterId]);
    await assertDepartment(db, body.application.departmentId);

    const result = await db.transaction(async (tx) => {
      const { application: a, force: _f, ...c } = body;
      const [cand] = await tx
        .insert(candidates)
        .values({ ...c, createdBy: req.auth.userId })
        .returning();
      const ownerId = a.ownerRecruiterId === undefined ? req.auth.userId : a.ownerRecruiterId;
      const [application] = await tx
        .insert(applications)
        .values({
          candidateId: cand.id,
          positionApplied: a.positionApplied,
          departmentId: a.departmentId ?? null,
          applicationDate: a.applicationDate ?? todayISO(),
          priorityRank: a.priorityRank ?? null,
          ownerRecruiterId: ownerId,
          nextFollowupDate: a.nextFollowupDate ?? null,
        })
        .returning();
      await tx.insert(stageHistory).values({
        applicationId: application.id,
        fromStage: null,
        toStage: 'application_received',
        note: 'Application created',
        userId: req.auth.userId,
      });
      await writeAudit(tx, req, {
        action: 'create',
        entity: 'candidate',
        entityId: cand.id,
        summary: `added candidate ${fullName(cand)} for ${application.positionApplied}`,
        after: { candidate: cand, application },
      });
      if (ownerId && ownerId !== req.auth.userId) {
        await notify(tx, [ownerId], {
          title: 'Candidate assigned to you',
          body: `${fullName(cand)} for ${application.positionApplied}`,
          link: `/recruitment/candidates/${cand.id}`,
        });
      }
      return { candidate: cand, application };
    });
    return reply.status(201).send({ ...result, candidate: maskCnic(req, result.candidate) });
  });

  app.get('/candidates/:id', view, async (req) => {
    const { id } = idParam.parse(req.params);
    const cand = await loadCandidate(db, id);
    const today = todayISO();
    const apps = await db
      .select({
        id: applications.id,
        positionApplied: applications.positionApplied,
        departmentId: applications.departmentId,
        departmentName: departments.name,
        applicationDate: applications.applicationDate,
        status: applications.status,
        currentStage: applications.currentStage,
        priorityRank: applications.priorityRank,
        ownerId: applications.ownerRecruiterId,
        ownerName: owner.name,
        nextFollowupDate: applications.nextFollowupDate,
        hiredSipId: applications.hiredSipId,
        createdAt: applications.createdAt,
        updatedAt: applications.updatedAt,
        daysInStage: daysInStageSql(today),
      })
      .from(applications)
      .leftJoin(owner, eq(applications.ownerRecruiterId, owner.id))
      .leftJoin(departments, eq(applications.departmentId, departments.id))
      .where(eq(applications.candidateId, id))
      .orderBy(desc(applications.id));
    const appIds = apps.map((a) => a.id);

    const history = appIds.length
      ? await db
          .select({
            id: stageHistory.id,
            applicationId: stageHistory.applicationId,
            fromStage: stageHistory.fromStage,
            toStage: stageHistory.toStage,
            note: stageHistory.note,
            userName: users.name,
            at: stageHistory.createdAt,
          })
          .from(stageHistory)
          .leftJoin(users, eq(stageHistory.userId, users.id))
          .where(inArray(stageHistory.applicationId, appIds))
          .orderBy(desc(stageHistory.id))
      : [];

    const ivs = appIds.length
      ? await db.select().from(interviews).where(inArray(interviews.applicationId, appIds)).orderBy(desc(interviews.scheduledAt))
      : [];

    const comms = await db
      .select({
        id: communications.id,
        channel: communications.channel,
        direction: communications.direction,
        subject: communications.subject,
        summary: communications.summary,
        occurredAt: communications.occurredAt,
        nextFollowupDate: communications.nextFollowupDate,
        userName: users.name,
      })
      .from(communications)
      .leftJoin(users, eq(communications.userId, users.id))
      .where(eq(communications.candidateId, id))
      .orderBy(desc(communications.occurredAt), desc(communications.id));

    const names = await userNames(db, ivs.flatMap((i) => i.interviewerIds));
    const posById = new Map(apps.map((a) => [a.id, a.positionApplied]));
    return {
      candidate: { ...maskCnic(req, cand), code: candidateCode(cand.id), name: fullName(cand) },
      applications: apps,
      stageHistory: history,
      interviews: ivs.map((i) => ({
        ...i,
        positionApplied: posById.get(i.applicationId) ?? null,
        interviewers: i.interviewerIds.map((uid) => ({ id: uid, name: names.get(uid) ?? 'Unknown user' })),
      })),
      communications: comms,
    };
  });

  app.patch('/candidates/:id', manage, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ ...candidateFields, force: z.boolean().optional() })
      .partial()
      .parse(req.body);
    const before = await loadCandidate(db, id);
    const { force, ...patch } = body;
    const touchesContact = patch.email !== undefined || patch.phone !== undefined;
    if (touchesContact && !force) {
      const dup = await findDuplicate(
        db,
        { email: patch.email !== undefined ? patch.email : before.email, phone: patch.phone !== undefined ? patch.phone : before.phone },
        id,
      );
      if (dup) return reply.status(409).send(duplicateReply(dup));
    }
    const after = await db.transaction(async (tx) => {
      const [row] = await tx.update(candidates).set(patch).where(eq(candidates.id, id)).returning();
      await writeAudit(tx, req, {
        action: 'update',
        entity: 'candidate',
        entityId: id,
        summary: `updated the details of ${fullName(row)}`,
        before,
        after: row,
      });
      return row;
    });
    return maskCnic(req, after);
  });

  app.delete('/candidates/:id', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const cand = await loadCandidate(db, id);
    const [hired] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(and(eq(applications.candidateId, id), isNotNull(applications.hiredSipId)));
    if (hired) throw new ConflictError('This candidate was hired; their record is kept as the employee source');
    await db.transaction(async (tx) => {
      await tx.update(candidates).set({ deletedAt: new Date() }).where(eq(candidates.id, id));
      await writeAudit(tx, req, {
        action: 'delete',
        entity: 'candidate',
        entityId: id,
        summary: `removed candidate ${fullName(cand)}`,
        before: cand,
      });
    });
    return { ok: true };
  });

  /* ---------------- Applications ---------------- */

  app.post('/candidates/:id/applications', manage, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const a = z.object(applicationFields).parse(req.body);
    const cand = await loadCandidate(db, id);
    await assertActiveUsers(db, [a.ownerRecruiterId]);
    await assertDepartment(db, a.departmentId);
    const [same] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(
          eq(applications.candidateId, id),
          openApp(),
          sql`lower(${applications.positionApplied}) = lower(${a.positionApplied})`,
        ),
      );
    if (same) throw new ConflictError(`${fullName(cand)} already has an open application for ${a.positionApplied}`);
    const row = await db.transaction(async (tx) => {
      const [application] = await tx
        .insert(applications)
        .values({
          candidateId: id,
          positionApplied: a.positionApplied,
          departmentId: a.departmentId ?? null,
          applicationDate: a.applicationDate ?? todayISO(),
          priorityRank: a.priorityRank ?? null,
          ownerRecruiterId: a.ownerRecruiterId === undefined ? req.auth.userId : a.ownerRecruiterId,
          nextFollowupDate: a.nextFollowupDate ?? null,
        })
        .returning();
      await tx.insert(stageHistory).values({
        applicationId: application.id,
        fromStage: null,
        toStage: 'application_received',
        note: 'Application created',
        userId: req.auth.userId,
      });
      await writeAudit(tx, req, {
        action: 'create',
        entity: 'application',
        entityId: application.id,
        summary: `added an application from ${fullName(cand)} for ${application.positionApplied}`,
        after: application,
      });
      return application;
    });
    return reply.status(201).send(row);
  });

  app.patch('/applications/:id', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = z.object(applicationFields).partial().parse(req.body);
    const { app: before, cand } = await loadApplication(db, id);
    await assertActiveUsers(db, [patch.ownerRecruiterId]);
    await assertDepartment(db, patch.departmentId);
    return db.transaction(async (tx) => {
      const [after] = await tx
        .update(applications)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(applications.id, id))
        .returning();
      await writeAudit(tx, req, {
        action: 'update',
        entity: 'application',
        entityId: id,
        summary: `updated the ${after.positionApplied} application of ${fullName(cand)}`,
        before,
        after,
      });
      if (patch.ownerRecruiterId && patch.ownerRecruiterId !== before.ownerRecruiterId && patch.ownerRecruiterId !== req.auth.userId) {
        await notify(tx, [patch.ownerRecruiterId], {
          title: 'Candidate assigned to you',
          body: `${fullName(cand)} for ${after.positionApplied}`,
          link: `/recruitment/candidates/${cand.id}`,
        });
      }
      return after;
    });
  });

  /** Move to a stage (drag on the board or "Move stage"). */
  app.post('/applications/:id/stage', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        stage: z.enum(PIPELINE_STAGES),
        note: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(1000).nullable().optional()),
        /** the stage the client saw; a mismatch means someone else moved it */
        fromStage: z.enum(PIPELINE_STAGES).optional(),
      })
      .parse(req.body);
    return db.transaction(async (tx) => {
      const { app: current, cand } = await loadApplication(tx, id, true);
      if (body.fromStage && body.fromStage !== current.currentStage) {
        throw new ConflictError(`${fullName(cand)} was moved to ${stageLabel(current.currentStage)} by someone else; refresh and try again`);
      }
      assertMoveAllowed(current, body.stage);
      const reopened = current.status === 'rejected' && body.stage !== 'offer_rejected';
      return applyStage(
        tx,
        req,
        current,
        cand,
        body.stage,
        body.note ?? (reopened ? 'Reopened' : null),
        {},
        reopened ? `reopened ${fullName(cand)} at ${stageLabel(body.stage)}` : undefined,
      );
    });
  });

  /** Reject: stage stays where it is, status becomes rejected. */
  app.post('/applications/:id/reject', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const { reason } = z
      .object({ reason: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(1000).nullable().optional()) })
      .parse(req.body ?? {});
    return db.transaction(async (tx) => {
      const { app: current, cand } = await loadApplication(tx, id, true);
      if (current.status === 'hired') throw new ConflictError(`${fullName(cand)} is already hired`);
      if (current.status === 'rejected') throw new ConflictError(`${fullName(cand)} is already rejected`);
      const [after] = await tx
        .update(applications)
        .set({ status: 'rejected', nextFollowupDate: null, updatedAt: new Date() })
        .where(eq(applications.id, id))
        .returning();
      await tx.insert(stageHistory).values({
        applicationId: id,
        fromStage: current.currentStage,
        toStage: current.currentStage,
        note: reason ? `Rejected: ${reason}` : 'Rejected',
        userId: req.auth.userId,
      });
      await writeAudit(tx, req, {
        action: 'reject',
        entity: 'application',
        entityId: id,
        summary: `rejected ${fullName(cand)} for ${current.positionApplied} at ${stageLabel(current.currentStage)}`,
        before: { stage: current.currentStage, status: current.status },
        after: { stage: after.currentStage, status: after.status, reason: reason ?? null },
      });
      return after;
    });
  });

  /** Hire: the one action that crosses into Employees. */
  app.post('/applications/:id/hire', manage, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        dateOfJoining: isoDate,
        departmentId: z.number().int().positive(),
        designationId: z.number().int().positive(),
        employmentStatus: z.enum(EMPLOYMENT_STATUSES),
        managerSipId: z.preprocess((v) => (v === '' ? null : v), z.string().trim().nullable().optional()),
        cnic: cnicSchema,
        /** required when hiring straight from Offer made */
        confirm: z.boolean().optional(),
      })
      .parse(req.body);

    const [dept] = await db.select().from(departments).where(eq(departments.id, body.departmentId));
    if (!dept) throw new ValidationError('Department not found');
    const [desig] = await db.select().from(designations).where(eq(designations.id, body.designationId));
    if (!desig || !desig.active) throw new ValidationError('Designation not found');
    if (body.managerSipId) {
      const [mgr] = await db.select({ status: employees.status }).from(employees).where(eq(employees.sipId, body.managerSipId));
      if (!mgr || mgr.status === 'inactive') throw new ValidationError('Manager must be a current employee');
    }

    const result = await db.transaction(async (tx) => {
      const { app: current, cand } = await loadApplication(tx, id, true);
      if (current.hiredSipId || current.status === 'hired') {
        throw new ConflictError(`${fullName(cand)} is already hired as SIP ${current.hiredSipId ?? '—'}`);
      }
      if (current.status === 'rejected') throw new ConflictError('This application was rejected; reopen it before hiring');
      if (current.currentStage === 'offer_made') {
        if (!body.confirm) throw new ValidationError('The offer is not marked accepted yet; confirm to hire anyway');
      } else if (current.currentStage !== 'offer_accepted') {
        throw new ValidationError(`Hire needs an accepted offer; ${fullName(cand)} is at ${stageLabel(current.currentStage)}`);
      }
      const cnic = body.cnic ?? cand.cnic;
      if (body.cnic && body.cnic !== cand.cnic) {
        await tx.update(candidates).set({ cnic: body.cnic }).where(eq(candidates.id, cand.id));
      }
      // the same checks as adding an employee by hand: CNIC not on another record,
      // designation belongs to the department, manager is an active employee
      await checkReferences(tx, {
        cnic,
        departmentId: body.departmentId,
        designationId: body.designationId,
        managerSipId: body.managerSipId ?? null,
      } as EmployeeInput);
      const emp = await createEmployee(
        tx,
        {
          firstName: cand.firstName,
          middleInitial: cand.middleInitial,
          lastName: cand.lastName,
          cnic,
          email: cand.email,
          phone: cand.phone,
          altPhone: cand.altPhone,
          address1: cand.address1,
          address2: cand.address2,
          city: cand.city,
          state: cand.state,
          postalCode: cand.postalCode,
          country: cand.country,
          gender: cand.gender,
          dateOfBirth: cand.dateOfBirth,
          departmentId: body.departmentId,
          designationId: body.designationId,
          managerSipId: body.managerSipId ?? null,
          employmentStatus: body.employmentStatus,
          dateOfJoining: body.dateOfJoining,
          sourceCandidateId: cand.id,
        },
        { userId: req.auth.userId, ip: req.ip },
      );
      const application = await applyStage(
        tx,
        req,
        current,
        cand,
        'hired',
        `Hired as SIP ${emp.sipId}, joining ${body.dateOfJoining}`,
        { hiredSipId: emp.sipId },
        `hired ${fullName(cand)} as ${desig.title} (SIP ${emp.sipId})`,
      );
      await tx.update(applications).set({ nextFollowupDate: null }).where(eq(applications.id, id));
      const recipients = await userIdsWithPermission(tx, 'employees.manage');
      await notify(tx, recipients, {
        title: 'New hire waiting for documents',
        body: `${fullName(cand)} joins ${body.dateOfJoining} as ${desig.title}, ${dept.name}. Upload the CNIC copy and signed contract to activate.`,
        link: `/employees/${emp.sipId}`,
      });
      return { sipId: emp.sipId, employee: emp, application };
    });
    return reply.status(201).send(result);
  });

  /* ---------------- Interviews ---------------- */

  app.get('/interviews', view, async (req) => {
    const q = z
      .object({
        scope: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
        candidateId: z.coerce.number().int().optional(),
        applicationId: z.coerce.number().int().optional(),
        interviewerId: z.coerce.number().int().optional(),
        mode: z.enum(INTERVIEW_MODES).optional(),
        outcome: z.enum([...INTERVIEW_OUTCOMES, 'none']).optional(),
        search: z.string().trim().optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
      })
      .parse(req.query);
    const p = paginationSchema.parse(req.query);
    const now = new Date();
    const conds: Array<SQL | undefined> = [isNull(candidates.deletedAt)];
    if (q.scope === 'upcoming') conds.push(gte(interviews.scheduledAt, now));
    if (q.scope === 'past') conds.push(lt(interviews.scheduledAt, now));
    if (q.candidateId) conds.push(eq(candidates.id, q.candidateId));
    if (q.applicationId) conds.push(eq(interviews.applicationId, q.applicationId));
    if (q.interviewerId) conds.push(sql`${q.interviewerId} = any(${interviews.interviewerIds})`);
    if (q.mode) conds.push(eq(interviews.mode, q.mode));
    if (q.outcome === 'none') conds.push(isNull(interviews.outcome));
    else if (q.outcome) conds.push(eq(interviews.outcome, q.outcome));
    if (q.search) conds.push(or(ilike(candidateNameSql, `%${q.search}%`), ilike(applications.positionApplied, `%${q.search}%`)));
    if (q.from) conds.push(sql`(${interviews.scheduledAt} at time zone ${config.TZ_BUSINESS})::date >= ${q.from}`);
    if (q.to) conds.push(sql`(${interviews.scheduledAt} at time zone ${config.TZ_BUSINESS})::date <= ${q.to}`);
    const where = and(...conds);

    const rows = await db
      .select({
        id: interviews.id,
        applicationId: interviews.applicationId,
        candidateId: candidates.id,
        candidateName: candidateNameSql,
        positionApplied: applications.positionApplied,
        stage: applications.currentStage,
        scheduledAt: interviews.scheduledAt,
        mode: interviews.mode,
        interviewerIds: interviews.interviewerIds,
        outcome: interviews.outcome,
        rating: interviews.rating,
        feedbackNotes: interviews.feedbackNotes,
        followupAction: interviews.followupAction,
      })
      .from(interviews)
      .innerJoin(applications, eq(interviews.applicationId, applications.id))
      .innerJoin(candidates, eq(applications.candidateId, candidates.id))
      .where(where)
      .orderBy(q.scope === 'upcoming' ? asc(interviews.scheduledAt) : desc(interviews.scheduledAt))
      .limit(p.pageSize)
      .offset(offsetOf(p));
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(interviews)
      .innerJoin(applications, eq(interviews.applicationId, applications.id))
      .innerJoin(candidates, eq(applications.candidateId, candidates.id))
      .where(where);
    const names = await userNames(db, rows.flatMap((r) => r.interviewerIds));
    return {
      data: rows.map((r) => ({
        ...r,
        interviewers: r.interviewerIds.map((uid) => ({ id: uid, name: names.get(uid) ?? 'Unknown user' })),
      })),
      meta: pageMeta(p, n),
    };
  });

  app.post('/interviews', manage, async (req, reply) => {
    const body = z
      .object({
        applicationId: z.number().int().positive(),
        scheduledAt: z.coerce.date({ invalid_type_error: 'must be a date and time' }),
        mode: z.enum(INTERVIEW_MODES),
        interviewerIds: z.array(z.number().int().positive()).min(1, 'pick at least one interviewer').max(10),
        note: z.string().trim().max(1000).optional(),
      })
      .parse(req.body);
    if (Number.isNaN(body.scheduledAt.getTime())) throw new ValidationError('scheduledAt: must be a date and time');
    await assertActiveUsers(db, body.interviewerIds);
    const result = await db.transaction(async (tx) => {
      const { app: current, cand } = await loadApplication(tx, body.applicationId, true);
      if (CLOSED_STATUSES.includes(current.status)) {
        throw new ConflictError(`This application is ${current.status}; reopen it before scheduling an interview`);
      }
      const [iv] = await tx
        .insert(interviews)
        .values({
          applicationId: current.id,
          scheduledAt: body.scheduledAt,
          mode: body.mode,
          interviewerIds: [...new Set(body.interviewerIds)],
          createdBy: req.auth.userId,
        })
        .returning();
      const when = fmtWhen.format(body.scheduledAt);
      await writeAudit(tx, req, {
        action: 'create',
        entity: 'interview',
        entityId: iv.id,
        summary: `scheduled a ${stageLabel(body.mode).toLowerCase()} interview with ${fullName(cand)} for ${when}`,
        after: iv,
      });
      let application = current;
      if (current.currentStage === 'application_received' || current.currentStage === 'screening') {
        application = await applyStage(tx, req, current, cand, 'interview_scheduled', body.note || `Interview on ${when}`);
      }
      await notify(tx, iv.interviewerIds.filter((uid) => uid !== req.auth.userId), {
        title: 'Interview scheduled',
        body: `${fullName(cand)} for ${current.positionApplied}, ${when} (${stageLabel(body.mode).toLowerCase()})`,
        link: `/recruitment/candidates/${cand.id}`,
      });
      return { interview: iv, application };
    });
    return reply.status(201).send(result);
  });

  /** Reschedule, change panel, or record the outcome. */
  app.patch('/interviews/:id', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        scheduledAt: z.coerce.date().optional(),
        mode: z.enum(INTERVIEW_MODES).optional(),
        interviewerIds: z.array(z.number().int().positive()).min(1).max(10).optional(),
        outcome: z.enum(INTERVIEW_OUTCOMES).nullable().optional(),
        rating: z.number().int().min(1).max(5).nullable().optional(),
        feedbackNotes: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(4000).nullable().optional()),
        followupAction: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(500).nullable().optional()),
      })
      .parse(req.body);
    if (body.interviewerIds) await assertActiveUsers(db, body.interviewerIds);
    return db.transaction(async (tx) => {
      const [before] = await tx.select().from(interviews).where(eq(interviews.id, id)).for('update');
      if (!before) throw new NotFoundError('Interview not found');
      const { app: current, cand } = await loadApplication(tx, before.applicationId, true);
      const [after] = await tx
        .update(interviews)
        .set({ ...body, interviewerIds: body.interviewerIds ? [...new Set(body.interviewerIds)] : undefined })
        .where(eq(interviews.id, id))
        .returning();
      const recording = body.outcome != null && before.outcome == null;
      await writeAudit(tx, req, {
        action: recording ? 'record_outcome' : 'update',
        entity: 'interview',
        entityId: id,
        summary: recording
          ? `recorded a ${body.outcome} interview outcome for ${fullName(cand)}${after.rating ? `, rated ${after.rating} of 5` : ''}`
          : `updated the interview with ${fullName(cand)}`,
        before,
        after,
      });
      let application = current;
      if (after.outcome && current.currentStage === 'interview_scheduled' && current.status !== 'rejected') {
        application = await applyStage(tx, req, current, cand, 'interview_completed', `Outcome: ${after.outcome}`);
      }
      const added = (body.interviewerIds ?? []).filter((uid) => !before.interviewerIds.includes(uid) && uid !== req.auth.userId);
      const moved = body.scheduledAt && body.scheduledAt.getTime() !== before.scheduledAt.getTime();
      if (added.length || moved) {
        await notify(tx, moved ? after.interviewerIds.filter((u) => u !== req.auth.userId) : added, {
          title: moved ? 'Interview rescheduled' : 'Interview scheduled',
          body: `${fullName(cand)} for ${current.positionApplied}, ${fmtWhen.format(after.scheduledAt)}`,
          link: `/recruitment/candidates/${cand.id}`,
        });
      }
      return { interview: after, application };
    });
  });

  /* ---------------- Communications and follow-ups ---------------- */

  app.get('/candidates/:id/communications', view, async (req) => {
    const { id } = idParam.parse(req.params);
    await loadCandidate(db, id);
    const rows = await db
      .select({
        id: communications.id,
        channel: communications.channel,
        direction: communications.direction,
        subject: communications.subject,
        summary: communications.summary,
        occurredAt: communications.occurredAt,
        nextFollowupDate: communications.nextFollowupDate,
        userName: users.name,
      })
      .from(communications)
      .leftJoin(users, eq(communications.userId, users.id))
      .where(eq(communications.candidateId, id))
      .orderBy(desc(communications.occurredAt), desc(communications.id));
    return { data: rows };
  });

  app.post('/candidates/:id/communications', manage, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        channel: z.enum(COMM_CHANNELS),
        direction: z.enum(COMM_DIRECTIONS),
        subject: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(200).nullable().optional()),
        summary: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(4000).nullable().optional()),
        occurredAt: z.coerce.date().optional(),
        /** sets the application's next follow-up; null clears it, omitted leaves it */
        nextFollowupDate: optDate,
        applicationId: z.number().int().positive().optional(),
      })
      .parse(req.body);
    if (!body.subject && !body.summary) throw new ValidationError('Add a subject or a summary of the contact');
    if (body.nextFollowupDate && body.nextFollowupDate < todayISO()) throw new ValidationError('The next follow-up cannot be in the past');
    const cand = await loadCandidate(db, id);
    const result = await db.transaction(async (tx) => {
      let target: typeof applications.$inferSelect | undefined;
      if (body.applicationId) {
        [target] = await tx.select().from(applications).where(and(eq(applications.id, body.applicationId), eq(applications.candidateId, id)));
        if (!target) throw new ValidationError('That application belongs to a different candidate');
      } else {
        [target] = await tx
          .select()
          .from(applications)
          .where(and(eq(applications.candidateId, id), openApp()))
          .orderBy(desc(applications.id))
          .limit(1);
      }
      const [row] = await tx
        .insert(communications)
        .values({
          candidateId: id,
          channel: body.channel,
          direction: body.direction,
          subject: body.subject ?? null,
          summary: body.summary ?? null,
          occurredAt: body.occurredAt ?? new Date(),
          nextFollowupDate: body.nextFollowupDate ?? null,
          userId: req.auth.userId,
        })
        .returning();
      if (target && body.nextFollowupDate !== undefined) {
        await tx
          .update(applications)
          .set({ nextFollowupDate: body.nextFollowupDate, updatedAt: new Date() })
          .where(eq(applications.id, target.id));
      }
      const channel = body.channel === 'whatsapp' ? 'WhatsApp message' : body.channel === 'call' ? 'call' : 'email';
      await writeAudit(tx, req, {
        action: 'create',
        entity: 'communication',
        entityId: row.id,
        summary: `logged ${body.direction === 'inbound' ? 'an inbound' : 'an outbound'} ${channel} with ${fullName(cand)}`,
        after: row,
      });
      return { communication: row, applicationId: target?.id ?? null };
    });
    return reply.status(201).send(result);
  });

  /** Open applications with a follow-up due today or overdue (scope=due), or all scheduled (scope=all). */
  app.get('/followups', view, async (req) => {
    const q = z
      .object({ scope: z.enum(['due', 'all']).default('due'), ownerId: z.coerce.number().int().optional(), mine: z.coerce.boolean().optional() })
      .parse(req.query);
    const today = todayISO();
    const rows = await db
      .select({
        applicationId: applications.id,
        candidateId: candidates.id,
        name: candidateNameSql,
        positionApplied: applications.positionApplied,
        stage: applications.currentStage,
        nextFollowupDate: applications.nextFollowupDate,
        ownerId: owner.id,
        ownerName: owner.name,
        lastContactAt: sql<Date | null>`(select max(c.occurred_at) from communications c where c.candidate_id = ${candidates.id})`.mapWith(communications.occurredAt),
      })
      .from(applications)
      .innerJoin(candidates, eq(applications.candidateId, candidates.id))
      .leftJoin(owner, eq(applications.ownerRecruiterId, owner.id))
      .where(
        and(
          isNull(candidates.deletedAt),
          openApp(),
          isNotNull(applications.nextFollowupDate),
          q.scope === 'due' ? lte(applications.nextFollowupDate, today) : undefined,
          q.ownerId ? eq(applications.ownerRecruiterId, q.ownerId) : undefined,
          q.mine ? eq(applications.ownerRecruiterId, req.auth.userId) : undefined,
        ),
      )
      .orderBy(asc(applications.nextFollowupDate));
    return {
      today,
      data: rows.map((r) => ({ ...r, overdue: (r.nextFollowupDate ?? today) < today, dueToday: r.nextFollowupDate === today })),
    };
  });
}

