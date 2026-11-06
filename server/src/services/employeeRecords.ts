/**
 * Employee register helpers: input validation (CNIC, phone, postal code),
 * read scoping and sensitive-field redaction, the manager-chain check, the
 * detail loader, readable audit summaries, and status changes (activate,
 * deactivate, reactivate) shared by the single and bulk endpoints.
 *
 * Creating an employee and the activation rules themselves live in the shared
 * services/employees.ts (createEmployee, activationBlockers).
 */
import { and, asc, desc, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z, ZodError, type ZodIssue } from 'zod';
import type { DbOrTx } from '../db/client.js';
import {
  DOCUMENT_TYPES,
  EMPLOYMENT_STATUSES,
  REQUIRED_DOCUMENTS,
  departments,
  designations,
  employeeDocuments,
  employees,
  sessions,
  users,
  type DocumentType,
} from '../db/schema.js';
import { invalidateAuthCache, type AuthContext } from '../auth/session.js';
import { can } from '../auth/plugin.js';
import { notify, writeAudit } from '../lib/audit.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { activationBlockers } from './employees.js';
import { fullName, userIdForSip } from './people.js';

type Employee = typeof employees.$inferSelect;
type Actor = Parameters<typeof writeAudit>[1];

/* ------------------------------------------------------------------ */
/* Field rules                                                          */
/* ------------------------------------------------------------------ */

const CNIC_RE = /^\d{5}-\d{7}-\d$/;

/** '#####-#######-#' kept as is; 13 bare digits (spaces allowed) formatted; anything else null. */
export function normalizeCnic(v: string): string | null {
  const t = v.trim();
  if (CNIC_RE.test(t)) return t;
  const digits = t.replace(/\s+/g, '');
  if (/^\d{13}$/.test(digits)) return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
  return null;
}

/** Phones are free text, but never an address: digits and + - ( ) . / spaces, plus "ext" or "x". */
export function phoneProblem(v: string): string | null {
  const rest = v.replace(/ext\.?|x/gi, ' ');
  if (/[A-Za-z]/.test(rest)) return 'This looks like an address, not a phone number';
  if (!/^[\d\s+()\-./]+$/.test(rest)) return 'Use digits, spaces, + - ( ) and "ext" only';
  const digits = v.replace(/\D/g, '').length;
  if (digits < 7 || digits > 18) return 'Enter a full phone number';
  return null;
}

function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Optional text: undefined = not sent, '' or null = clear. */
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v || null));

const optDate = (label: string) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      if (!v) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !isRealDate(v)) {
        ctx.addIssue({ code: 'custom', message: `Enter ${label} as YYYY-MM-DD` });
        return z.NEVER;
      }
      return v;
    });

const cnicField = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (!v || !v.trim()) return null;
    const n = normalizeCnic(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'Use the format 12345-1234567-1 (13 digits)' });
      return z.NEVER;
    }
    return n;
  });

const phoneField = z
  .string()
  .max(40, 'Use at most 40 characters')
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    const t = v?.trim();
    if (!t) return null;
    const p = phoneProblem(t);
    if (p) {
      ctx.addIssue({ code: 'custom', message: p });
      return z.NEVER;
    }
    return t.replace(/\s+/g, ' ');
  });

const postalField = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    const t = v?.trim();
    if (!t) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/.test(t)) {
      ctx.addIssue({ code: 'custom', message: 'Use 2 to 12 letters, digits, spaces or dashes' });
      return z.NEVER;
    }
    return t; // text: leading zeros are kept
  });

const emailField = z
  .string()
  .trim()
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (!v) return null;
    if (!z.string().email().safeParse(v).success) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid email address' });
      return z.NEVER;
    }
    return v.toLowerCase();
  });

const middleInitialField = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    const t = v?.trim().replace(/\.$/, '');
    if (!t) return null;
    if (!/^[A-Za-z]$/.test(t)) {
      ctx.addIssue({ code: 'custom', message: 'One letter' });
      return z.NEVER;
    }
    return t.toUpperCase();
  });

const idField = z
  .union([z.number().int().positive(), z.null()])
  .optional();

/** Contact and address: the only fields an employee may edit on their own record. */
export const contactShape = {
  email: emailField,
  phone: phoneField,
  altPhone: phoneField,
  address1: optText(120),
  address2: optText(120),
  city: optText(60),
  state: optText(60),
  postalCode: postalField,
  country: optText(60),
};

const employeeShape = {
  firstName: z.string().trim().min(1, 'Enter a first name').max(60),
  middleInitial: middleInitialField,
  lastName: z.string().trim().min(1, 'Enter a last name').max(60),
  gender: optText(20),
  dateOfBirth: optDate('the date of birth'),
  cnic: cnicField,
  ...contactShape,
  departmentId: idField,
  designationId: idField,
  managerSipId: optText(20),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
  dateOfJoining: z
    .string()
    .trim()
    .refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && isRealDate(v), 'Enter the joining date as YYYY-MM-DD'),
  bankName: optText(80),
  accountNo: z
    .string()
    .trim()
    .max(34, 'Use at most 34 characters')
    .nullish()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      if (!v) return null;
      if (!/^[A-Za-z0-9 -]+$/.test(v)) {
        ctx.addIssue({ code: 'custom', message: 'Use letters, digits, spaces or dashes (IBAN or account number)' });
        return z.NEVER;
      }
      return v.replace(/\s+/g, ' ').toUpperCase();
    }),
  remarks: optText(2000),
};

export const createEmployeeSchema = z.object(employeeShape);
export const updateEmployeeSchema = z.object(employeeShape).partial();
export const contactSchema = z.object(contactShape);
export type EmployeeInput = z.infer<typeof updateEmployeeSchema>;

/** Throws a 400 shaped like a zod error, so the form can show it under the field. */
export function fieldError(path: string, message: string): never {
  const issue: ZodIssue = { code: 'custom', path: [path], message };
  throw new ZodError([issue]);
}

/* ------------------------------------------------------------------ */
/* Read scoping and redaction                                           */
/* ------------------------------------------------------------------ */

export const SENSITIVE_FIELDS = ['cnic', 'bankName', 'accountNo', 'dateOfBirth'] as const;

export function canSeeSensitive(auth: AuthContext, sipId?: string | null): boolean {
  return (!!sipId && auth.sipId === sipId) || can(auth, 'employees.sensitive');
}

/** Removes CNIC, bank and date of birth unless the caller may see them. */
export function redact<T extends Record<string, unknown>>(row: T, show: boolean): T {
  if (show) return row;
  const copy: Record<string, unknown> = { ...row };
  for (const k of SENSITIVE_FIELDS) delete copy[k];
  return copy as T;
}

/** List scope: employees.view sees everyone; team.view only direct reports. */
export function scopeCondition(auth: AuthContext): SQL | undefined {
  if (can(auth, 'employees.view')) return undefined;
  return eq(employees.managerSipId, auth.sipId ?? '__none__');
}

/* ------------------------------------------------------------------ */
/* Lookups and checks                                                   */
/* ------------------------------------------------------------------ */

export async function loadEmployee(tx: DbOrTx, sipId: string): Promise<Employee> {
  const [emp] = await tx.select().from(employees).where(eq(employees.sipId, sipId));
  if (!emp) throw new NotFoundError(`No employee with SIP ID ${sipId}`);
  return emp;
}

/**
 * Checks department, designation, manager and CNIC for a create or an update.
 * `current` is the record before the change (undefined on create).
 */
export async function checkReferences(tx: DbOrTx, input: EmployeeInput, current?: Employee): Promise<void> {
  const deptId = input.departmentId !== undefined ? input.departmentId : current?.departmentId ?? null;
  if (input.departmentId != null && input.departmentId !== current?.departmentId) {
    const [d] = await tx.select().from(departments).where(eq(departments.id, input.departmentId));
    if (!d) fieldError('departmentId', 'Unknown department');
    if (!d.active) fieldError('departmentId', `${d.name} is no longer in use`);
  }
  const desigId = input.designationId !== undefined ? input.designationId : current?.designationId ?? null;
  if (desigId != null && (input.designationId !== undefined || input.departmentId !== undefined)) {
    const [g] = await tx.select().from(designations).where(eq(designations.id, desigId));
    if (!g) fieldError('designationId', 'Unknown designation');
    if (!g.active && desigId !== current?.designationId) fieldError('designationId', `${g.title} is no longer in use`);
    if (g.departmentId != null && deptId != null && g.departmentId !== deptId) {
      fieldError('designationId', `${g.title} belongs to another department`);
    }
  }
  if (input.managerSipId && input.managerSipId !== current?.managerSipId) {
    await checkManager(tx, current?.sipId ?? null, input.managerSipId);
  }
  if (input.cnic && input.cnic !== current?.cnic) {
    const [dup] = await tx
      .select({ sipId: employees.sipId })
      .from(employees)
      .where(and(eq(employees.cnic, input.cnic), current ? ne(employees.sipId, current.sipId) : undefined));
    if (dup) fieldError('cnic', `This CNIC is already on record for ${dup.sipId}`);
  }
}

/**
 * A manager must be another active employee, and not someone who already
 * reports (directly or further down) to this person.
 */
export async function checkManager(tx: DbOrTx, sipId: string | null, managerSipId: string): Promise<void> {
  if (sipId && managerSipId === sipId) fieldError('managerSipId', 'A person cannot manage themself');
  const [m] = await tx
    .select({ sipId: employees.sipId, status: employees.status, managerSipId: employees.managerSipId })
    .from(employees)
    .where(eq(employees.sipId, managerSipId));
  if (!m) fieldError('managerSipId', `No employee with SIP ID ${managerSipId}`);
  if (m.status !== 'active') fieldError('managerSipId', 'Pick an active employee as manager');
  if (!sipId) return;
  // Walk up from the proposed manager; reaching this person means a cycle.
  const seen = new Set<string>([m.sipId]);
  let next = m.managerSipId;
  while (next) {
    if (next === sipId) fieldError('managerSipId', 'This person reports to them; pick someone outside their own chain');
    if (seen.has(next)) break;
    seen.add(next);
    const [up] = await tx.select({ managerSipId: employees.managerSipId }).from(employees).where(eq(employees.sipId, next));
    next = up?.managerSipId ?? null;
  }
}

/* ------------------------------------------------------------------ */
/* Detail                                                               */
/* ------------------------------------------------------------------ */

export const mgr = alias(employees, 'mgr');
export const mgrNameSql = sql<string>`trim(${mgr.firstName} || ' ' || coalesce(nullif(${mgr.middleInitial}, '') || '. ', '') || ${mgr.lastName})`;

export function documentRows(tx: DbOrTx, sipId: string) {
  return tx
    .select({
      id: employeeDocuments.id,
      type: employeeDocuments.type,
      fileName: employeeDocuments.fileName,
      mimeType: employeeDocuments.mimeType,
      sizeBytes: employeeDocuments.sizeBytes,
      uploadedAt: employeeDocuments.uploadedAt,
      uploadedByName: users.name,
    })
    .from(employeeDocuments)
    .leftJoin(users, eq(employeeDocuments.uploadedBy, users.id))
    .where(and(eq(employeeDocuments.sipId, sipId), isNull(employeeDocuments.deletedAt)))
    .orderBy(desc(employeeDocuments.uploadedAt));
}

/** Everything the profile page shows, with sensitive fields removed unless allowed. */
export async function employeeDetail(tx: DbOrTx, auth: AuthContext, sipId: string) {
  const [row] = await tx
    .select({
      emp: employees,
      departmentName: departments.name,
      designationTitle: designations.title,
      managerName: mgrNameSql,
      managerStatus: mgr.status,
    })
    .from(employees)
    .leftJoin(departments, eq(employees.departmentId, departments.id))
    .leftJoin(designations, eq(employees.designationId, designations.id))
    .leftJoin(mgr, eq(employees.managerSipId, mgr.sipId))
    .where(eq(employees.sipId, sipId));
  if (!row) throw new NotFoundError(`No employee with SIP ID ${sipId}`);
  const [linked] = await tx
    .select({ id: users.id, email: users.email, name: users.name, status: users.status })
    .from(users)
    .where(eq(users.sipId, sipId));
  const reports = await tx
    .select({ sipId: employees.sipId, firstName: employees.firstName, middleInitial: employees.middleInitial, lastName: employees.lastName, status: employees.status })
    .from(employees)
    .where(eq(employees.managerSipId, sipId))
    .orderBy(asc(employees.firstName));
  const documents = await documentRows(tx, sipId);
  const blockers = row.emp.status === 'active' ? [] : await activationBlockers(tx, sipId);
  const show = canSeeSensitive(auth, sipId);
  const { createdBy: _c, ...emp } = row.emp;
  return {
    ...redact(emp, show),
    name: fullName(row.emp),
    departmentName: row.departmentName,
    designationTitle: row.designationTitle,
    managerName: row.managerName,
    managerStatus: row.managerStatus,
    sensitiveVisible: show,
    linkedUser: linked ?? null,
    directReports: reports.map((r) => ({ sipId: r.sipId, name: fullName(r), status: r.status })),
    blockers,
    requiredDocuments: REQUIRED_DOCUMENTS,
    documents,
  };
}

/* ------------------------------------------------------------------ */
/* Readable audit lines                                                 */
/* ------------------------------------------------------------------ */

const FIELD_LABELS: Record<string, string> = {
  firstName: 'first name',
  middleInitial: 'middle initial',
  lastName: 'last name',
  gender: 'gender',
  dateOfBirth: 'date of birth',
  cnic: 'CNIC',
  email: 'email',
  phone: 'phone',
  altPhone: 'alternate phone',
  address1: 'address',
  address2: 'address line 2',
  city: 'city',
  state: 'state',
  postalCode: 'postal code',
  country: 'country',
  departmentId: 'department',
  designationId: 'designation',
  managerSipId: 'manager',
  employmentStatus: 'employment status',
  dateOfJoining: 'joining date',
  bankName: 'bank',
  accountNo: 'account number',
  remarks: 'remarks',
};

/** Keys whose value actually changes. */
export function changedKeys(before: Employee, input: EmployeeInput): Array<keyof EmployeeInput> {
  return (Object.keys(input) as Array<keyof EmployeeInput>).filter(
    (k) => input[k] !== undefined && (input[k] ?? null) !== ((before as Record<string, unknown>)[k] ?? null),
  );
}

/**
 * One line for the activity feed, e.g. "changed the department of Usman Tariq
 * to Operations" or "updated the phone and email of Hira Siddiqui".
 */
export async function updateSummary(tx: DbOrTx, before: Employee, after: Employee, keys: string[]): Promise<string> {
  const name = fullName(after);
  if (keys.length === 2 && keys.includes('departmentId') && keys.includes('designationId') && after.departmentId && after.designationId) {
    const [d] = await tx.select({ name: departments.name }).from(departments).where(eq(departments.id, after.departmentId));
    const [g] = await tx.select({ title: designations.title }).from(designations).where(eq(designations.id, after.designationId));
    return `moved ${name} to ${d?.name ?? 'another department'} as ${g?.title ?? 'another designation'}`;
  }
  if (keys.length === 1) {
    const k = keys[0];
    if (k === 'departmentId') {
      if (!after.departmentId) return `removed ${name} from their department`;
      const [d] = await tx.select({ name: departments.name }).from(departments).where(eq(departments.id, after.departmentId));
      return `changed the department of ${name} to ${d?.name ?? 'another department'}`;
    }
    if (k === 'designationId') {
      if (!after.designationId) return `cleared the designation of ${name}`;
      const [g] = await tx.select({ title: designations.title }).from(designations).where(eq(designations.id, after.designationId));
      return `changed the designation of ${name} to ${g?.title ?? 'another designation'}`;
    }
    if (k === 'managerSipId') {
      if (!after.managerSipId) return `removed the manager of ${name}`;
      const m = await loadEmployee(tx, after.managerSipId);
      return `set ${fullName(m)} as the manager of ${name}`;
    }
    if (k === 'employmentStatus') return `changed the employment status of ${name} to ${after.employmentStatus}`;
    if (k === 'firstName' || k === 'lastName' || k === 'middleInitial') return `corrected the name of ${fullName(before)} to ${name}`;
  }
  return `updated the ${fieldList(keys)} of ${name}`;
}

/** "phone and email", "address, city and postal code", "5 fields" */
export function fieldList(keys: string[]): string {
  const labels = [...new Set(keys.map((k) => FIELD_LABELS[k] ?? k))];
  return labels.length <= 3 ? joinWords(labels) : `${labels.length} fields`;
}

function joinWords(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

export const DOC_PHRASE: Record<DocumentType, string> = {
  resume: 'a resume',
  cnic: 'a CNIC copy',
  offer_letter: 'an offer letter',
  contract: 'a signed contract',
  other: 'a document',
};

export const DOCUMENT_TYPE_VALUES = DOCUMENT_TYPES;

/* ------------------------------------------------------------------ */
/* Status changes                                                       */
/* ------------------------------------------------------------------ */

export type StatusOp = 'activate' | 'deactivate' | 'reactivate';

/**
 * Applies one status change and writes the audit row. Throws ConflictError
 * when the change is not allowed (with the missing documents listed).
 */
export async function changeStatus(
  tx: DbOrTx,
  actor: Actor,
  sipId: string,
  op: StatusOp,
  reason?: string | null,
): Promise<Employee> {
  const before = await loadEmployee(tx, sipId);
  const name = fullName(before);

  if (op === 'deactivate') {
    if (before.status === 'inactive') throw new ConflictError(`${name} is already inactive`);
    const [after] = await tx
      .update(employees)
      .set({ status: 'inactive', deactivatedAt: new Date(), updatedAt: new Date() })
      .where(eq(employees.sipId, sipId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'deactivate',
      entity: 'employee',
      entityId: sipId,
      summary: reason ? `deactivated ${name}: ${reason}` : `deactivated ${name}`,
      before: { status: before.status, deactivatedAt: before.deactivatedAt },
      after: { status: after.status, deactivatedAt: after.deactivatedAt, reason: reason ?? null },
    });
    // someone who has left can no longer sign in; an admin can re-enable the account under Users
    const linked = await tx
      .update(users)
      .set({ status: 'disabled' })
      .where(and(eq(users.sipId, sipId), eq(users.status, 'active')))
      .returning({ id: users.id, email: users.email });
    for (const u of linked) {
      await tx.delete(sessions).where(eq(sessions.userId, u.id));
      await writeAudit(tx, actor, { action: 'disable', entity: 'user', entityId: u.id, summary: `disabled the account ${u.email} because ${name} was deactivated` });
    }
    if (linked.length) invalidateAuthCache();
    return after;
  }

  if (op === 'activate' && before.status !== 'pending') {
    throw new ConflictError(before.status === 'active' ? `${name} is already active` : `${name} is inactive; reactivate instead`);
  }
  if (op === 'reactivate' && before.status !== 'inactive') {
    throw new ConflictError(`${name} is not inactive`);
  }

  const missing = await activationBlockers(tx, sipId);
  if (op === 'activate' && missing.length > 0) {
    throw new ConflictError(`${name} cannot go active yet. Missing: ${missing.join(', ')}`);
  }
  // Reactivation returns someone to active, or to pending when documents are now missing.
  const status = missing.length === 0 ? 'active' : 'pending';
  const [after] = await tx
    .update(employees)
    .set({ status, deactivatedAt: null, updatedAt: new Date() })
    .where(eq(employees.sipId, sipId))
    .returning();
  await writeAudit(tx, actor, {
    action: op,
    entity: 'employee',
    entityId: sipId,
    summary:
      op === 'activate' ? `activated ${name}` : status === 'active' ? `reactivated ${name}` : `reactivated ${name} as pending (missing ${missing.join(', ')})`,
    before: { status: before.status, deactivatedAt: before.deactivatedAt },
    after: { status: after.status, deactivatedAt: null, reason: reason ?? null },
  });
  if (status === 'active') {
    const userId = await userIdForSip(tx, sipId);
    await notify(tx, [userId], {
      title: 'Your employee record is active',
      body: `${name}, SIP ID ${sipId}. Payslips and leave now run on this record.`,
      link: '/me/profile',
    });
  }
  return after;
}

/** Audit before/after for a history reader without employees.sensitive. */
export function redactAudit(v: unknown, show: boolean): unknown {
  if (show || !v || typeof v !== 'object') return v;
  const copy: Record<string, unknown> = { ...(v as Record<string, unknown>) };
  for (const k of SENSITIVE_FIELDS) if (k in copy) copy[k] = '(hidden)';
  return copy;
}
