/**
 * Who may read which audit rows. The audit trail records every module, so a
 * reader only sees rows of modules they can already open, and sensitive
 * fields (CNIC, bank, date of birth) are hidden without employees.sensitive.
 * Used by the audit page and the dashboard activity feed.
 */
import { inArray, type SQL } from 'drizzle-orm';
import { auditTrail } from '../db/schema.js';
import { can } from '../auth/plugin.js';
import type { AuthContext } from '../auth/session.js';
import type { Permission } from '../auth/permissions.js';
import { redactAudit } from '../services/employeeRecords.js';

/** Audit entity → permissions that open it (any one is enough). */
const ENTITY_ACCESS: Record<string, Permission[]> = {
  employee: ['employees.view'],
  employee_document: ['employees.view', 'documents.manage'],
  department: ['employees.view', 'employees.manage'],
  designation: ['employees.view', 'employees.manage'],
  candidate: ['recruitment.view'],
  application: ['recruitment.view'],
  interview: ['recruitment.view'],
  communication: ['recruitment.view'],
  payroll_run: ['payroll.view'],
  payslip: ['payroll.view'],
  salary_structure: ['payroll.view'],
  loan: ['payroll.view'],
  leave_application: ['leave.view', 'leave.approve', 'leave.manage'],
  leave_ledger: ['leave.view', 'leave.manage'],
  leave_type: ['leave.view', 'leave.manage'],
  settings: ['settings.manage', 'payroll.manage', 'leave.manage'],
  user: ['users.manage'],
  role: ['users.manage'],
  company: ['users.manage'],
};

/** A WHERE clause limiting audit rows to what the caller may read; undefined = everything. */
export function auditScope(auth: AuthContext): SQL | undefined {
  if (auth.permissions.includes('*')) return undefined;
  const allowed = Object.entries(ENTITY_ACCESS)
    .filter(([, perms]) => perms.some((p) => can(auth, p)))
    .map(([entity]) => entity);
  // inArray with an empty list matches nothing, which is the intent
  return inArray(auditTrail.entity, allowed.length ? allowed : ['__none__']);
}

/** Hides CNIC, bank details and date of birth in before/after unless allowed. */
export function redactAuditRow<T extends { before: unknown; after: unknown }>(row: T, auth: AuthContext): T {
  const show = can(auth, 'employees.sensitive');
  return { ...row, before: redactAudit(row.before, show), after: redactAudit(row.after, show) };
}
