import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { employees } from '../db/schema.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { hasPermission, type Permission } from './permissions.js';
import { resolveSession, type AuthContext } from './session.js';
import { resolveApiKey } from '../services/apiKeys.js';

export const SESSION_COOKIE = 'hrms_session';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

/** preHandler: resolves the session cookie (or Bearer token) into request.auth. */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const cookieToken = req.cookies?.[SESSION_COOKIE];
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const token = cookieToken ?? bearer;
  if (!token) throw new UnauthorizedError('Not signed in');
  // other systems sign in with an API key; people with a session cookie
  const auth = bearer?.startsWith('hrms_') && !cookieToken ? await resolveApiKey(bearer) : await resolveSession(token);
  if (!auth) throw new UnauthorizedError('Session expired or invalid');
  req.auth = auth;
}

export function can(auth: AuthContext, perm: Permission): boolean {
  return hasPermission(auth.permissions, perm);
}

/** preHandler factory: requires at least one of the given permissions. */
export function requirePermission(...perms: Permission[]): preHandlerHookHandler {
  return async (req) => {
    if (!req.auth) throw new UnauthorizedError();
    if (!perms.some((p) => can(req.auth, p))) {
      throw new ForbiddenError(`Missing permission: ${perms.join(' or ')}`);
    }
  };
}

/** For /me endpoints: the signed-in account must be linked to an employee. */
export function requireSelf(req: FastifyRequest): string {
  if (!req.auth.sipId) throw new ForbiddenError('Your account is not linked to an employee record');
  return req.auth.sipId;
}

/** True when `sipId` reports directly to the signed-in manager. */
export async function isInTeam(auth: AuthContext, sipId: string): Promise<boolean> {
  if (!auth.sipId) return false;
  const [row] = await db
    .select({ sipId: employees.sipId })
    .from(employees)
    .where(and(eq(employees.sipId, sipId), eq(employees.managerSipId, auth.sipId)));
  return !!row;
}

/**
 * Can the signed-in user read this employee's record?
 * Everyone may read their own; employees.view reads all; team.view reads direct reports.
 */
export async function canReadEmployee(auth: AuthContext, sipId: string): Promise<boolean> {
  if (auth.sipId === sipId) return true;
  if (can(auth, 'employees.view')) return true;
  if (can(auth, 'team.view')) return isInTeam(auth, sipId);
  return false;
}

export async function assertCanReadEmployee(auth: AuthContext, sipId: string): Promise<void> {
  if (!(await canReadEmployee(auth, sipId))) throw new ForbiddenError('You cannot view this employee');
}
