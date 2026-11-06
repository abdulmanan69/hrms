/**
 * Base data every company needs: roles, settings, leave types and a starter
 * set of departments. Idempotent; runs inside a company context, so every
 * row lands in that company.
 */
import { count } from 'drizzle-orm';
import { ROLE_PRESETS } from '../auth/permissions.js';
import { db } from '../db/client.js';
import { departments, designations, leaveTypes, roles, settings } from '../db/schema.js';
import { DEFAULT_SETTINGS } from './settings.js';

export const DEFAULT_DEPARTMENTS: Record<string, string[]> = {
  Sales: ['Sales Associate', 'Senior Sales Associate', 'Team Lead, Sales'],
  Operations: ['Operations Executive', 'Operations Manager'],
  Quality: ['QA Analyst', 'QA Lead'],
  'Human Resources': ['HR Officer', 'Recruiter', 'HR Manager'],
  Finance: ['Accountant', 'Payroll Officer', 'Finance Manager'],
  IT: ['IT Support Engineer', 'Software Engineer', 'IT Manager'],
};

export const DEFAULT_LEAVE_TYPES = [
  { name: 'Casual', annualEntitlementDays: 10, isPaid: true, accrualRule: 'annual' as const, carryForwardMax: 0, sortOrder: 1 },
  { name: 'Sick', annualEntitlementDays: 8, isPaid: true, accrualRule: 'annual' as const, carryForwardMax: 0, sortOrder: 2 },
  { name: 'Vacation', annualEntitlementDays: 14, isPaid: true, accrualRule: 'annual' as const, carryForwardMax: 7, sortOrder: 3 },
  { name: 'Unpaid', annualEntitlementDays: 0, isPaid: false, accrualRule: 'none' as const, carryForwardMax: 0, sortOrder: 4 },
  { name: 'Other', annualEntitlementDays: 0, isPaid: false, accrualRule: 'none' as const, carryForwardMax: 0, sortOrder: 5 },
];

/** Call inside runInCompany(companyId, …). */
export async function setupCompany(companyName: string): Promise<void> {
  // roles: add missing presets; never overwrite changes made in the app
  for (const [name, preset] of Object.entries(ROLE_PRESETS)) {
    await db
      .insert(roles)
      .values({ name, label: preset.label, description: preset.description, permissions: preset.permissions, isSystem: true })
      .onConflictDoNothing({ target: [roles.companyId, roles.name] });
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const v = key === 'company' ? { ...(value as object), name: companyName } : value;
    await db.insert(settings).values({ key, value: v }).onConflictDoNothing({ target: [settings.companyId, settings.key] });
  }

  const [{ n: typeCount }] = await db.select({ n: count() }).from(leaveTypes);
  if (typeCount === 0) await db.insert(leaveTypes).values(DEFAULT_LEAVE_TYPES);

  const [{ n: deptCount }] = await db.select({ n: count() }).from(departments);
  if (deptCount === 0) {
    for (const [name, titles] of Object.entries(DEFAULT_DEPARTMENTS)) {
      const [d] = await db.insert(departments).values({ name }).returning();
      await db.insert(designations).values(titles.map((title) => ({ title, departmentId: d.id })));
    }
  }
}
