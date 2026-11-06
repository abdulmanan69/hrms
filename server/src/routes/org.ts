/** Departments and designations: the small lookup lists every module reads. */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { departments, designations, employees } from '../db/schema.js';
import { can, requirePermission } from '../auth/plugin.js';
import type { Permission } from '../auth/permissions.js';
import { employeeNameSql } from '../services/people.js';
import { NotFoundError } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  // Lookups are readable by any signed-in user (forms need them).
  app.get('/departments', async () => {
    const rows = await db
      .select({
        id: departments.id,
        name: departments.name,
        active: departments.active,
        headcount: sql<number>`(select count(*)::int from ${employees} where ${employees.departmentId} = ${departments.id} and ${employees.status} = 'active')`,
      })
      .from(departments)
      .orderBy(asc(departments.name));
    return { data: rows };
  });

  app.get('/designations', async () => {
    const rows = await db
      .select({
        id: designations.id,
        title: designations.title,
        departmentId: designations.departmentId,
        departmentName: departments.name,
        active: designations.active,
      })
      .from(designations)
      .leftJoin(departments, eq(designations.departmentId, departments.id))
      .orderBy(asc(designations.title));
    return { data: rows };
  });

  /**
   * Light employee lookup for pickers (payroll, leave, users, manager field).
   * Managers with only team.view see their direct reports.
   */
  app.get(
    '/people',
    {
      preHandler: requirePermission(
        'employees.view',
        'team.view',
        'payroll.view',
        'leave.view',
        'leave.approve',
        'leave.manage',
        'users.manage',
        'recruitment.manage',
      ),
    },
    async (req) => {
      const q = z
        .object({
          search: z.string().trim().optional(),
          status: z.enum(['active', 'pending', 'inactive', 'all']).default('active'),
          limit: z.coerce.number().int().min(1).max(500).default(50),
        })
        .parse(req.query);
      const broad = ['employees.view', 'payroll.view', 'leave.view', 'leave.approve', 'leave.manage', 'users.manage', 'recruitment.manage'].some(
        (p) => can(req.auth, p as Permission),
      );
      const term = q.search ? `%${q.search}%` : null;
      const rows = await db
        .select({
          sipId: employees.sipId,
          name: employeeNameSql,
          status: employees.status,
          departmentName: departments.name,
          designationTitle: designations.title,
        })
        .from(employees)
        .leftJoin(departments, eq(employees.departmentId, departments.id))
        .leftJoin(designations, eq(employees.designationId, designations.id))
        .where(
          and(
            q.status === 'all' ? undefined : eq(employees.status, q.status),
            broad ? undefined : eq(employees.managerSipId, req.auth.sipId ?? '__none__'),
            term
              ? or(
                  ilike(employees.sipId, term),
                  ilike(employeeNameSql, term),
                  // matching on CNIC would reveal whose CNIC it is: only for those allowed to see CNICs
                  can(req.auth, 'employees.sensitive') ? ilike(employees.cnic, term) : undefined,
                )
              : undefined,
          ),
        )
        .orderBy(asc(employees.firstName), asc(employees.lastName))
        .limit(q.limit);
      return { data: rows };
    },
  );

  const manage = { preHandler: requirePermission('employees.manage') };

  app.post('/departments', manage, async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const [row] = await db.insert(departments).values(body).returning();
    await writeAudit(db, req, { action: 'create', entity: 'department', entityId: row.id, summary: `added the ${row.name} department`, after: row });
    return reply.status(201).send(row);
  });

  app.patch('/departments/:id', manage, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ name: z.string().trim().min(1).max(80).optional(), active: z.boolean().optional() }).parse(req.body);
    const [before] = await db.select().from(departments).where(eq(departments.id, id));
    if (!before) throw new NotFoundError('Department not found');
    const [after] = await db.update(departments).set(body).where(eq(departments.id, id)).returning();
    await writeAudit(db, req, { action: 'update', entity: 'department', entityId: id, summary: `updated the ${after.name} department`, before, after });
    return after;
  });

  app.post('/designations', manage, async (req, reply) => {
    const body = z
      .object({ title: z.string().trim().min(1).max(80), departmentId: z.number().int().nullable().optional() })
      .parse(req.body);
    const [row] = await db.insert(designations).values({ title: body.title, departmentId: body.departmentId ?? null }).returning();
    await writeAudit(db, req, { action: 'create', entity: 'designation', entityId: row.id, summary: `added the designation ${row.title}`, after: row });
    return reply.status(201).send(row);
  });

  app.patch('/designations/:id', manage, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z
      .object({
        title: z.string().trim().min(1).max(80).optional(),
        departmentId: z.number().int().nullable().optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);
    const [before] = await db.select().from(designations).where(eq(designations.id, id));
    if (!before) throw new NotFoundError('Designation not found');
    const [after] = await db.update(designations).set(body).where(eq(designations.id, id)).returning();
    await writeAudit(db, req, { action: 'update', entity: 'designation', entityId: id, summary: `updated the designation ${after.title}`, before, after });
    return after;
  });
}
