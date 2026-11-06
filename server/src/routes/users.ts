import type { FastifyInstance } from 'fastify';
import { asc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { employees, roles, users } from '../db/schema.js';
import { requirePermission } from '../auth/plugin.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { revokeUserSessions, type AuthContext } from '../auth/session.js';
import { hashPassword } from '../lib/crypto.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { employeeNameSql } from '../services/people.js';

const userBody = z.object({
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
  name: z.string().trim().min(1).max(120),
  roleId: z.number().int(),
  sipId: z.string().trim().min(1).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requirePermission('users.manage'));

  app.get('/', async (req) => {
    const q = z.object({ search: z.string().optional() }).parse(req.query);
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        isSuperAdmin: users.isSuperAdmin,
        sipId: users.sipId,
        employeeName: employeeNameSql,
        roleId: roles.id,
        roleName: roles.name,
        roleLabel: roles.label,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .leftJoin(employees, eq(users.sipId, employees.sipId))
      .where(q.search ? or(ilike(users.name, `%${q.search}%`), ilike(users.email, `%${q.search}%`)) : undefined)
      .orderBy(asc(users.name));
    return { data: rows };
  });

  app.get('/roles', async () => {
    const rows = await db
      .select({
        id: roles.id,
        name: roles.name,
        label: roles.label,
        description: roles.description,
        permissions: roles.permissions,
        isSystem: roles.isSystem,
        userCount: sql<number>`(select count(*)::int from ${users} where ${users.roleId} = ${roles.id})`,
      })
      .from(roles)
      .orderBy(asc(roles.id));
    return { data: rows, permissions: PERMISSIONS };
  });

  app.post('/', async (req, reply) => {
    const body = userBody.extend({ password: z.string().min(8, 'Use at least 8 characters') }).parse(req.body);
    await assertRole(body.roleId, req.auth);
    if (body.sipId) await assertSipFree(body.sipId);
    const [created] = await db
      .insert(users)
      .values({
        email: body.email,
        name: body.name,
        roleId: body.roleId,
        sipId: body.sipId ?? null,
        status: body.status ?? 'active',
        passwordHash: await hashPassword(body.password),
      })
      .returning({ id: users.id, email: users.email, name: users.name });
    await writeAudit(db, req, { action: 'create', entity: 'user', entityId: created.id, summary: `created the account ${created.email}`, after: created });
    return reply.status(201).send(created);
  });

  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = userBody.partial().parse(req.body);
    const [before] = await db.select().from(users).where(eq(users.id, id));
    if (!before) throw new NotFoundError('User not found');
    assertMayManage(before, req.auth);
    if (id === req.auth.userId) {
      if (body.status === 'disabled') throw new ValidationError('You cannot disable your own account');
      if (body.roleId !== undefined && body.roleId !== before.roleId) throw new ForbiddenError('You cannot change your own role');
      if (body.sipId !== undefined && body.sipId !== before.sipId) throw new ForbiddenError('You cannot link your own account to an employee record');
    }
    if (body.roleId) await assertRole(body.roleId, req.auth);
    if (body.sipId && body.sipId !== before.sipId) await assertSipFree(body.sipId);
    const [after] = await db.update(users).set(body).where(eq(users.id, id)).returning();
    if (body.status === 'disabled' || (body.roleId && body.roleId !== before.roleId)) await revokeUserSessions(id);
    await writeAudit(db, req, {
      action: 'update',
      entity: 'user',
      entityId: id,
      summary: `updated the account ${after.email}`,
      before: { ...before, passwordHash: undefined },
      after: { ...after, passwordHash: undefined },
    });
    return { ok: true };
  });

  app.post('/:id/password', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ password: z.string().min(8, 'Use at least 8 characters') }).parse(req.body);
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) throw new NotFoundError('User not found');
    assertMayManage(target, req.auth);
    const [u] = await db.update(users).set({ passwordHash: await hashPassword(body.password) }).where(eq(users.id, id)).returning({ email: users.email });
    if (!u) throw new NotFoundError('User not found');
    await revokeUserSessions(id);
    await writeAudit(db, req, { action: 'reset_password', entity: 'user', entityId: id, summary: `reset the password of ${u.email}` });
    return { ok: true };
  });

  app.patch('/roles/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z
      .object({
        label: z.string().trim().min(1).optional(),
        description: z.string().trim().nullable().optional(),
        permissions: z.array(z.enum([...PERMISSIONS, '*'] as [string, ...string[]])).optional(),
      })
      .parse(req.body);
    const [before] = await db.select().from(roles).where(eq(roles.id, id));
    if (!before) throw new NotFoundError('Role not found');
    if (before.name === 'admin' && body.permissions && !body.permissions.includes('*')) {
      throw new ValidationError('The HR admin role always keeps full access');
    }
    // nobody can hand out (or edit a role holding) access they don't have themselves
    if (!grants(req.auth, before.permissions) || (body.permissions && !grants(req.auth, body.permissions))) {
      throw new ForbiddenError('You can only give out permissions you hold yourself');
    }
    if (before.name === req.auth.roleName && body.permissions) throw new ForbiddenError('You cannot change the permissions of your own role');
    const [after] = await db.update(roles).set(body).where(eq(roles.id, id)).returning();
    await writeAudit(db, req, { action: 'update', entity: 'role', entityId: id, summary: `changed the ${after.label} role`, before, after });
    return { ok: true };
  });
}

/** True when the caller holds every permission in `perms` ('*' holds all). */
function grants(auth: AuthContext, perms: string[]): boolean {
  if (auth.permissions.includes('*')) return true;
  return perms.every((p) => p !== '*' && auth.permissions.includes(p));
}

/** A role can only be given by someone who holds all of its access. */
async function assertRole(id: number, auth: AuthContext): Promise<void> {
  const [r] = await db.select({ id: roles.id, permissions: roles.permissions }).from(roles).where(eq(roles.id, id));
  if (!r) throw new ValidationError('Unknown role');
  if (!grants(auth, r.permissions)) throw new ForbiddenError('You can only give a role whose access you hold yourself');
}

/**
 * Super admin accounts are managed only by super admins: otherwise a company
 * admin could reset that password and reach every company.
 */
function assertMayManage(target: typeof users.$inferSelect, auth: AuthContext): void {
  if (target.isSuperAdmin && !auth.isSuperAdmin) throw new ForbiddenError('Only a super admin can change a super admin account');
}

async function assertSipFree(sipId: string): Promise<void> {
  const [emp] = await db.select({ sipId: employees.sipId }).from(employees).where(eq(employees.sipId, sipId));
  if (!emp) throw new ValidationError(`No employee with SIP ID ${sipId}`);
  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.sipId, sipId));
  if (taken) throw new ConflictError(`SIP ID ${sipId} is already linked to another account`);
}
