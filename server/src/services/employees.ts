/**
 * Creating an employee is shared by two paths: direct "Add employee"
 * (backfilling existing staff) and Recruitment's hire action, which converts
 * a candidate. Both go through createEmployee so the SIP ID, the leave grant
 * and the audit row are always written the same way.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import {
  REQUIRED_DOCUMENTS,
  employeeDocuments,
  employees,
  sipCounters,
  type DocumentType,
  type EmploymentStatus,
} from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { todayISO } from '../lib/dates.js';
import { accrueFor } from './leaveLedger.js';
import { fullName } from './people.js';

/** Next SIP ID for a year in the current company: 'YYYY-####'. Atomic, gap-free, never reused. */
export async function nextSipId(tx: DbOrTx, year: number): Promise<string> {
  const [row] = await tx
    .insert(sipCounters)
    .values({ year, last: 1 })
    .onConflictDoUpdate({ target: [sipCounters.companyId, sipCounters.year], set: { last: sql`${sipCounters.last} + 1` } })
    .returning({ last: sipCounters.last });
  return `${year}-${String(row.last).padStart(4, '0')}`;
}

export interface NewEmployee {
  firstName: string;
  middleInitial?: string | null;
  lastName: string;
  cnic?: string | null;
  email?: string | null;
  phone?: string | null;
  altPhone?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  gender?: string | null;
  dateOfBirth?: string | null;
  departmentId?: number | null;
  designationId?: number | null;
  managerSipId?: string | null;
  employmentStatus?: EmploymentStatus;
  dateOfJoining: string;
  bankName?: string | null;
  accountNo?: string | null;
  remarks?: string | null;
  sourceCandidateId?: number | null;
}

/**
 * Inserts the employee as 'pending' (documents still missing), grants the
 * leave owed so far, and writes the audit row. Run inside a transaction.
 */
export async function createEmployee(
  tx: DbOrTx,
  input: NewEmployee,
  actor: { userId: number | null; ip?: string | null },
): Promise<typeof employees.$inferSelect> {
  const year = Number(input.dateOfJoining.slice(0, 4)) || Number(todayISO().slice(0, 4));
  const sipId = await nextSipId(tx, year);
  const [emp] = await tx
    .insert(employees)
    .values({
      sipId,
      sourceCandidateId: input.sourceCandidateId ?? null,
      firstName: input.firstName.trim(),
      middleInitial: input.middleInitial?.trim() || null,
      lastName: input.lastName.trim(),
      cnic: input.cnic?.trim() || null,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      altPhone: input.altPhone?.trim() || null,
      address1: input.address1 ?? null,
      address2: input.address2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode?.trim() || null,
      country: input.country ?? null,
      gender: input.gender ?? null,
      dateOfBirth: input.dateOfBirth || null,
      departmentId: input.departmentId ?? null,
      designationId: input.designationId ?? null,
      managerSipId: input.managerSipId || null,
      employmentStatus: input.employmentStatus ?? 'probation',
      dateOfJoining: input.dateOfJoining,
      status: 'pending',
      bankName: input.bankName ?? null,
      accountNo: input.accountNo ?? null,
      remarks: input.remarks ?? null,
      createdBy: actor.userId,
    })
    .returning();

  const today = todayISO();
  await accrueFor(tx, emp, today > emp.dateOfJoining ? today : emp.dateOfJoining, actor.userId);

  await writeAudit(tx, actor, {
    action: 'create',
    entity: 'employee',
    entityId: sipId,
    summary: `added ${fullName(emp)} as SIP ${sipId}`,
    after: emp,
  });
  return emp;
}

/**
 * What still blocks an employee from going active: a CNIC number on the
 * record and an uploaded CNIC copy and signed contract.
 */
export async function activationBlockers(tx: DbOrTx, sipId: string): Promise<string[]> {
  const [emp] = await tx.select({ cnic: employees.cnic }).from(employees).where(eq(employees.sipId, sipId));
  if (!emp) return ['Employee not found'];
  const docs = await tx
    .select({ type: employeeDocuments.type })
    .from(employeeDocuments)
    .where(and(eq(employeeDocuments.sipId, sipId), isNull(employeeDocuments.deletedAt)));
  const have = new Set<DocumentType>(docs.map((d) => d.type));
  const missing: string[] = [];
  if (!emp.cnic) missing.push('CNIC number');
  for (const t of REQUIRED_DOCUMENTS) {
    if (!have.has(t)) missing.push(t === 'cnic' ? 'CNIC copy' : 'signed contract');
  }
  return missing;
}
