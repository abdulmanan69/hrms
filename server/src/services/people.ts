import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { employees, roles, users } from '../db/schema.js';

/** Display name: First + Middle Initial + Last. Never used as a key. */
export function fullName(p: { firstName: string; middleInitial?: string | null; lastName: string }): string {
  const mi = p.middleInitial?.trim();
  return [p.firstName.trim(), mi ? `${mi.replace(/\.$/, '')}.` : null, p.lastName.trim()].filter(Boolean).join(' ');
}

/** SQL expression for the same display name, for selects and search. */
export const employeeNameSql = sql<string>`trim(${employees.firstName} || ' ' || coalesce(nullif(${employees.middleInitial}, '') || '. ', '') || ${employees.lastName})`;

/** Active user accounts holding a permission (directly or via '*'). */
export async function userIdsWithPermission(tx: DbOrTx, perm: string): Promise<number[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.status, 'active'), sql`(${roles.permissions} && array[${perm}, '*']::text[])`));
  return rows.map((r) => r.id);
}

/** The account linked to an employee, if any. */
export async function userIdForSip(tx: DbOrTx, sipId: string): Promise<number | null> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.sipId, sipId), eq(users.status, 'active')));
  return row?.id ?? null;
}

/** The account of an employee's line manager, if any. */
export async function managerUserIdForSip(tx: DbOrTx, sipId: string): Promise<number | null> {
  const [emp] = await tx.select({ managerSipId: employees.managerSipId }).from(employees).where(eq(employees.sipId, sipId));
  if (!emp?.managerSipId) return null;
  return userIdForSip(tx, emp.managerSipId);
}
