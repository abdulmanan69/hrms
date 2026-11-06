/**
 * WaveTech HRMS schema. One person record flows from candidate to employee;
 * the employee's SIP ID is the key payroll and leave join on.
 *
 * Companies
 * - Every business table carries `company_id`. Postgres row-level security
 *   (migration 0002) limits every query to the company of the current
 *   request, and the column defaults to that company, so inserts never need
 *   to name it. See db/tenant.ts.
 * - References between business rows are composite, (company_id, id), so a
 *   row can never point at another company's row, even by mistake.
 * - Actor columns (created_by, approver_id …) reference users.id alone: a
 *   super admin from another company may be the one acting.
 *
 * Conventions
 * - Money is whole PKR in `integer` columns. The payroll engine rounds each
 *   line once, so A + B − C always reconciles to the rupee.
 * - Leave days are `double precision` so half days are possible.
 * - Dates without time are `date` columns read as 'YYYY-MM-DD' strings.
 * - Phone, CNIC, postal code are text so leading zeros and dashes survive.
 * - Nothing that payroll or compliance needs is hard-deleted: people are
 *   flagged inactive, candidates get `deleted_at`.
 * - Enum-like columns are text with a TypeScript union (see the *_VALUES
 *   arrays), so adding a value never needs a database enum migration.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').notNull().defaultNow();
const day = (name: string) => date(name, { mode: 'string' });

/**
 * The owning company. Defaults to the company of the current request
 * (`app.company_id`, set per transaction by db/tenant.ts); an insert made
 * outside a company context fails instead of landing in the wrong company.
 */
const companyId = () =>
  integer('company_id')
    .notNull()
    .default(sql`current_setting('app.company_id')::int`)
    .references(() => companies.id);

/* ------------------------------------------------------------------ */
/* Value lists                                                          */
/* ------------------------------------------------------------------ */

export const PIPELINE_STAGES = [
  'application_received',
  'screening',
  'interview_scheduled',
  'interview_completed',
  'feedback_received',
  'offer_made',
  'offer_accepted',
  'offer_rejected',
  'hired',
  'onboarding',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const APPLICATION_STATUSES = ['pending', 'screening', 'interviewed', 'offered', 'rejected', 'hired'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const INTERVIEW_MODES = ['phone', 'online', 'in_person'] as const;
export const INTERVIEW_OUTCOMES = ['positive', 'neutral', 'negative'] as const;
export const COMM_CHANNELS = ['email', 'whatsapp', 'call'] as const;
export const COMM_DIRECTIONS = ['inbound', 'outbound'] as const;

export const EMPLOYMENT_STATUSES = ['probation', 'contractual', 'permanent'] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];
/** pending = hired but documents incomplete; cannot be paid until active */
export const EMPLOYEE_STATUSES = ['pending', 'active', 'inactive'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const DOCUMENT_TYPES = ['resume', 'cnic', 'offer_letter', 'contract', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
/** Required before an employee can be activated */
export const REQUIRED_DOCUMENTS: DocumentType[] = ['cnic', 'contract'];

export const RUN_STATUSES = ['draft', 'approved', 'paid'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const PAYSLIP_SECTIONS = ['A', 'B', 'C'] as const;
export type PayslipSection = (typeof PAYSLIP_SECTIONS)[number];
export const LOAN_ENTRY_TYPES = ['loan', 'advance', 'deduction', 'waiver'] as const;
export type LoanEntryType = (typeof LOAN_ENTRY_TYPES)[number];

export const ACCRUAL_RULES = ['annual', 'monthly', 'none'] as const;
export const LEDGER_ENTRY_TYPES = ['accrual', 'application', 'adjustment', 'carry_forward', 'reversal'] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];
export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Platform: companies and sign-in                                      */
/* ------------------------------------------------------------------ */

/** Not row-secured: the platform reads it to resolve sign-ins and the switcher. */
export const companies = pgTable('companies', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  /** short code typed at sign-in when an email exists in several companies */
  slug: text('slug').notNull().unique(),
  status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
  createdAt: createdAt(),
});

export const roles = pgTable(
  'roles',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    name: text('name').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique('roles_company_id_uq').on(t.companyId, t.id), unique('roles_company_name_uq').on(t.companyId, t.name)],
);

/**
 * A sign-in belongs to one company. The same email may exist in several
 * companies (one account each); sign-in then asks which company.
 * Super admins (platform) can also switch into any company.
 */
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    roleId: integer('role_id').notNull(),
    /** linked staff record; null for accounts that are not employees */
    sipId: text('sip_id'),
    /** platform administrator: manages companies and may work in any of them */
    isSuperAdmin: boolean('is_super_admin').notNull().default(false),
    status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('users_company_email_uq').on(t.companyId, t.email),
    unique('users_company_sip_uq').on(t.companyId, t.sipId),
    index('users_email_idx').on(t.email),
    foreignKey({ name: 'users_role_fk', columns: [t.companyId, t.roleId], foreignColumns: [roles.companyId, roles.id] }),
    foreignKey({ name: 'users_employee_fk', columns: [t.companyId, t.sipId], foreignColumns: [employees.companyId, employees.sipId] }).onUpdate('cascade'),
  ],
);

/** Not row-secured: read before the company is known. */
export const sessions = pgTable(
  'sessions',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    /** the company this session works in: the user's own, or any for a super admin */
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/* ------------------------------------------------------------------ */
/* Shared core (per company)                                            */
/* ------------------------------------------------------------------ */

export const auditTrail = pgTable(
  'audit_trail',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    userId: integer('user_id').references((): AnyPgColumn => users.id),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    /** one-line human summary, shown in activity feeds */
    summary: text('summary'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_entity_idx').on(t.companyId, t.entity, t.entityId), index('audit_created_idx').on(t.companyId, t.id)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    userId: integer('user_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.companyId, t.userId, t.readAt)],
);

/** Key/value settings per company: payroll rules, leave week, company name. */
export const settings = pgTable(
  'settings',
  {
    companyId: companyId(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedBy: integer('updated_by').references((): AnyPgColumn => users.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'settings_pk', columns: [t.companyId, t.key] })],
);

/** SIP ID counters per company and year: 2026-0001, 2026-0002 … never reused. */
export const sipCounters = pgTable(
  'sip_counters',
  {
    companyId: companyId(),
    year: integer('year').notNull(),
    last: integer('last').notNull().default(0),
  },
  (t) => [primaryKey({ name: 'sip_counters_pk', columns: [t.companyId, t.year] })],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Every uploaded file (employee documents, leave attachments), compressed,
 * stored in the database so one backup holds everything. Rows that point at
 * a file keep the reference 'db:<id>' in their stored-name column.
 *
 * encoding: 'identity' = bytes as served; 'br' = Brotli, decompressed on download.
 * Images are already re-encoded smaller at upload (mime_type is the result).
 */
export const storedFiles = pgTable('stored_files', {
  id: serial('id').primaryKey(),
  companyId: companyId(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  /** size of the file as uploaded */
  originalSize: integer('original_size').notNull(),
  /** size of what is served (after image re-encoding) */
  servedSize: integer('served_size').notNull(),
  /** size of the bytes in `data` */
  storedSize: integer('stored_size').notNull(),
  encoding: text('encoding').$type<'identity' | 'br'>().notNull(),
  /** SHA-256 of the served bytes, for integrity checks */
  sha256: text('sha256').notNull(),
  data: bytea('data').notNull(),
  createdAt: createdAt(),
});

export const departments = pgTable(
  'departments',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique('departments_company_id_uq').on(t.companyId, t.id), unique('departments_company_name_uq').on(t.companyId, t.name)],
);

export const designations = pgTable(
  'designations',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    title: text('title').notNull(),
    departmentId: integer('department_id'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('designations_company_id_uq').on(t.companyId, t.id),
    foreignKey({ name: 'designations_department_fk', columns: [t.companyId, t.departmentId], foreignColumns: [departments.companyId, departments.id] }),
  ],
);

/* ------------------------------------------------------------------ */
/* Recruitment                                                          */
/* ------------------------------------------------------------------ */

export const candidates = pgTable(
  'candidates',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    firstName: text('first_name').notNull(),
    middleInitial: text('middle_initial'),
    lastName: text('last_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    altPhone: text('alt_phone'),
    address1: text('address1'),
    address2: text('address2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country'),
    gender: text('gender'),
    dateOfBirth: day('date_of_birth'),
    cnic: text('cnic'),
    source: text('source'),
    notes: text('notes'),
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [unique('candidates_company_id_uq').on(t.companyId, t.id), index('candidates_name_idx').on(t.companyId, t.lastName, t.firstName)],
);

export const applications = pgTable(
  'applications',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    candidateId: integer('candidate_id').notNull(),
    positionApplied: text('position_applied').notNull(),
    departmentId: integer('department_id'),
    applicationDate: day('application_date').notNull(),
    status: text('status').$type<ApplicationStatus>().notNull().default('pending'),
    currentStage: text('current_stage').$type<PipelineStage>().notNull().default('application_received'),
    priorityRank: integer('priority_rank'),
    ownerRecruiterId: integer('owner_recruiter_id').references((): AnyPgColumn => users.id),
    nextFollowupDate: day('next_followup_date'),
    /** null until hired; links the two modules */
    hiredSipId: text('hired_sip_id'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('applications_company_id_uq').on(t.companyId, t.id),
    foreignKey({ name: 'applications_candidate_fk', columns: [t.companyId, t.candidateId], foreignColumns: [candidates.companyId, candidates.id] }),
    foreignKey({ name: 'applications_department_fk', columns: [t.companyId, t.departmentId], foreignColumns: [departments.companyId, departments.id] }),
    foreignKey({ name: 'applications_hired_fk', columns: [t.companyId, t.hiredSipId], foreignColumns: [employees.companyId, employees.sipId] }).onUpdate('cascade'),
    index('applications_stage_idx').on(t.companyId, t.currentStage),
    index('applications_candidate_idx').on(t.companyId, t.candidateId),
    index('applications_followup_idx').on(t.companyId, t.nextFollowupDate),
  ],
);

export const stageHistory = pgTable(
  'stage_history',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    applicationId: integer('application_id').notNull(),
    fromStage: text('from_stage').$type<PipelineStage>(),
    toStage: text('to_stage').$type<PipelineStage>().notNull(),
    note: text('note'),
    userId: integer('user_id').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'stage_history_application_fk', columns: [t.companyId, t.applicationId], foreignColumns: [applications.companyId, applications.id] }).onDelete('cascade'),
    index('stage_history_app_idx').on(t.companyId, t.applicationId),
  ],
);

export const interviews = pgTable(
  'interviews',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    applicationId: integer('application_id').notNull(),
    scheduledAt: ts('scheduled_at').notNull(),
    interviewerIds: integer('interviewer_ids').array().notNull().default(sql`'{}'::int[]`),
    mode: text('mode').$type<(typeof INTERVIEW_MODES)[number]>().notNull(),
    outcome: text('outcome').$type<(typeof INTERVIEW_OUTCOMES)[number]>(),
    rating: integer('rating'),
    feedbackNotes: text('feedback_notes'),
    followupAction: text('followup_action'),
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'interviews_application_fk', columns: [t.companyId, t.applicationId], foreignColumns: [applications.companyId, applications.id] }).onDelete('cascade'),
    index('interviews_app_idx').on(t.companyId, t.applicationId),
    index('interviews_when_idx').on(t.companyId, t.scheduledAt),
  ],
);

export const communications = pgTable(
  'communications',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    candidateId: integer('candidate_id').notNull(),
    channel: text('channel').$type<(typeof COMM_CHANNELS)[number]>().notNull(),
    direction: text('direction').$type<(typeof COMM_DIRECTIONS)[number]>().notNull(),
    subject: text('subject'),
    summary: text('summary'),
    occurredAt: ts('occurred_at').notNull(),
    nextFollowupDate: day('next_followup_date'),
    userId: integer('user_id').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'communications_candidate_fk', columns: [t.companyId, t.candidateId], foreignColumns: [candidates.companyId, candidates.id] }),
    index('communications_candidate_idx').on(t.companyId, t.candidateId),
  ],
);

/* ------------------------------------------------------------------ */
/* Employees                                                            */
/* ------------------------------------------------------------------ */

export const employees = pgTable(
  'employees',
  {
    companyId: companyId(),
    /** auto-generated YYYY-####, per company, immutable, never reused */
    sipId: text('sip_id').notNull(),
    sourceCandidateId: integer('source_candidate_id'),
    firstName: text('first_name').notNull(),
    middleInitial: text('middle_initial'),
    lastName: text('last_name').notNull(),
    cnic: text('cnic'),
    email: text('email'),
    phone: text('phone'),
    altPhone: text('alt_phone'),
    address1: text('address1'),
    address2: text('address2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country'),
    gender: text('gender'),
    dateOfBirth: day('date_of_birth'),
    departmentId: integer('department_id'),
    designationId: integer('designation_id'),
    /** line manager; approves this person's leave */
    managerSipId: text('manager_sip_id'),
    employmentStatus: text('employment_status').$type<EmploymentStatus>().notNull().default('probation'),
    dateOfJoining: day('date_of_joining').notNull(),
    status: text('status').$type<EmployeeStatus>().notNull().default('pending'),
    bankName: text('bank_name'),
    accountNo: text('account_no'),
    remarks: text('remarks'),
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deactivatedAt: ts('deactivated_at'),
  },
  (t) => [
    primaryKey({ name: 'employees_pk', columns: [t.companyId, t.sipId] }),
    foreignKey({ name: 'employees_candidate_fk', columns: [t.companyId, t.sourceCandidateId], foreignColumns: [candidates.companyId, candidates.id] }),
    foreignKey({ name: 'employees_department_fk', columns: [t.companyId, t.departmentId], foreignColumns: [departments.companyId, departments.id] }),
    foreignKey({ name: 'employees_designation_fk', columns: [t.companyId, t.designationId], foreignColumns: [designations.companyId, designations.id] }),
    foreignKey({ name: 'employees_manager_fk', columns: [t.companyId, t.managerSipId], foreignColumns: [t.companyId, t.sipId] }).onUpdate('cascade'),
    // one person, one record: a CNIC appears once per company (empty CNICs don't collide)
    uniqueIndex('employees_cnic_uq').on(t.companyId, t.cnic),
    index('employees_dept_idx').on(t.companyId, t.departmentId),
    index('employees_status_idx').on(t.companyId, t.status),
    index('employees_manager_idx').on(t.companyId, t.managerSipId),
    index('employees_name_idx').on(t.companyId, t.lastName, t.firstName),
  ],
);

export const employeeDocuments = pgTable(
  'employee_documents',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    sipId: text('sip_id').notNull(),
    type: text('type').$type<DocumentType>().notNull(),
    fileName: text('file_name').notNull(),
    /** 'db:<stored_files.id>'; older rows may still name a file in UPLOAD_DIR until moved at boot */
    storedName: text('stored_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    uploadedBy: integer('uploaded_by').references((): AnyPgColumn => users.id),
    uploadedAt: ts('uploaded_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    foreignKey({ name: 'employee_documents_employee_fk', columns: [t.companyId, t.sipId], foreignColumns: [employees.companyId, employees.sipId] }).onUpdate('cascade'),
    index('employee_documents_sip_idx').on(t.companyId, t.sipId),
  ],
);

/* ------------------------------------------------------------------ */
/* Payroll                                                              */
/* ------------------------------------------------------------------ */

/** One row per rate period; an increment adds a row with a later effective_from. */
export const salaryStructures = pgTable(
  'salary_structures',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    sipId: text('sip_id').notNull(),
    effectiveFrom: day('effective_from').notNull(),
    basicSalary: integer('basic_salary').notNull(),
    houseRent: integer('house_rent').notNull().default(0),
    medicalAllowance: integer('medical_allowance').notNull().default(0),
    petrolAllowance: integer('petrol_allowance').notNull().default(0),
    otherAllowance: integer('other_allowance').notNull().default(0),
    /** sum of the components above */
    grossSalary: integer('gross_salary').notNull(),
    pfApplicable: boolean('pf_applicable').notNull().default(true),
    eobiApplicable: boolean('eobi_applicable').notNull().default(true),
    whtApplicable: boolean('wht_applicable').notNull().default(true),
    note: text('note'),
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'salary_structures_employee_fk', columns: [t.companyId, t.sipId], foreignColumns: [employees.companyId, employees.sipId] }).onUpdate('cascade'),
    uniqueIndex('salary_structures_period_uq').on(t.companyId, t.sipId, t.effectiveFrom),
  ],
);

export const payrollRuns = pgTable(
  'payroll_runs',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    /** 'YYYY-MM', one run per month per company */
    periodMonth: text('period_month').notNull(),
    daysOfMonth: integer('days_of_month').notNull(),
    workingDays: integer('working_days').notNull(),
    status: text('status').$type<RunStatus>().notNull().default('draft'),
    notes: text('notes'),
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    approvedBy: integer('approved_by').references((): AnyPgColumn => users.id),
    approvedAt: ts('approved_at'),
    paidAt: ts('paid_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('payroll_runs_company_id_uq').on(t.companyId, t.id), unique('payroll_runs_company_month_uq').on(t.companyId, t.periodMonth)],
);

export const payslips = pgTable(
  'payslips',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    runId: integer('run_id').notNull(),
    sipId: text('sip_id').notNull(),
    /** paid days at the earlier rate (or the only rate) */
    currentSalaryDays: doublePrecision('current_salary_days').notNull().default(0),
    /** paid days at the increment rate, 0 without a mid-month increment */
    newSalaryDays: doublePrecision('new_salary_days').notNull().default(0),
    notJoinedDays: doublePrecision('not_joined_days').notNull().default(0),
    unpaidDays: doublePrecision('unpaid_days').notNull().default(0),
    grossA: integer('gross_a').notNull().default(0),
    totalAdditionsB: integer('total_additions_b').notNull().default(0),
    totalDeductionsC: integer('total_deductions_c').notNull().default(0),
    netTotal: integer('net_total').notNull().default(0),
    /** name, department, designation, bank and rate periods frozen at compute time */
    snapshot: jsonb('snapshot').notNull().default(sql`'{}'::jsonb`),
    computedAt: ts('computed_at').notNull().defaultNow(),
  },
  (t) => [
    unique('payslips_company_id_uq').on(t.companyId, t.id),
    foreignKey({ name: 'payslips_run_fk', columns: [t.companyId, t.runId], foreignColumns: [payrollRuns.companyId, payrollRuns.id] }).onDelete('cascade'),
    foreignKey({ name: 'payslips_employee_fk', columns: [t.companyId, t.sipId], foreignColumns: [employees.companyId, employees.sipId] }).onUpdate('cascade'),
    uniqueIndex('payslips_run_sip_uq').on(t.companyId, t.runId, t.sipId),
    index('payslips_sip_idx').on(t.companyId, t.sipId),
  ],
);

export const payslipLines = pgTable(
  'payslip_lines',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    payslipId: integer('payslip_id').notNull(),
    section: text('section').$type<PayslipSection>().notNull(),
    component: text('component').notNull(),
    amount: integer('amount').notNull(),
    /** entered by a person (B additions, manual C) and kept across recomputes */
    isManual: boolean('is_manual').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    foreignKey({ name: 'payslip_lines_payslip_fk', columns: [t.companyId, t.payslipId], foreignColumns: [payslips.companyId, payslips.id] }).onDelete('cascade'),
    index('payslip_lines_payslip_idx').on(t.companyId, t.payslipId),
  ],
);

/**
 * Loan/advance ledger. amount is signed from the employee's debt view:
 * + loan/advance given, − deduction (repaid through payroll) or waiver.
 * balance_after is the running outstanding balance.
 */
export const loansAdvances = pgTable(
  'loans_advances',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    sipId: text('sip_id').notNull(),
    entryType: text('entry_type').$type<LoanEntryType>().notNull(),
    amount: integer('amount').notNull(),
    /** monthly deduction while a balance is outstanding (set on loan/advance entries) */
    installment: integer('installment'),
    entryDate: day('entry_date').notNull(),
    runId: integer('run_id'),
    note: text('note'),
    balanceAfter: integer('balance_after').notNull(),
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'loans_employee_fk', columns: [t.companyId, t.sipId], foreignColumns: [employees.companyId, employees.sipId] }).onUpdate('cascade'),
    foreignKey({ name: 'loans_run_fk', columns: [t.companyId, t.runId], foreignColumns: [payrollRuns.companyId, payrollRuns.id] }).onDelete('cascade'),
    index('loans_sip_idx').on(t.companyId, t.sipId, t.id),
  ],
);

/* ------------------------------------------------------------------ */
/* Leave                                                                */
/* ------------------------------------------------------------------ */

export const leaveTypes = pgTable(
  'leave_types',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    name: text('name').notNull(),
    annualEntitlementDays: doublePrecision('annual_entitlement_days').notNull().default(0),
    isPaid: boolean('is_paid').notNull().default(true),
    accrualRule: text('accrual_rule').$type<(typeof ACCRUAL_RULES)[number]>().notNull().default('annual'),
    /** most days that carry into next year; 0 = none */
    carryForwardMax: doublePrecision('carry_forward_max').notNull().default(0),
    requiresAttachment: boolean('requires_attachment').notNull().default(false),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [unique('leave_types_company_id_uq').on(t.companyId, t.id), unique('leave_types_company_name_uq').on(t.companyId, t.name)],
);

/** Every grant and deduction is a dated row; the balance is their running sum. */
export const leaveLedger = pgTable(
  'leave_ledger',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    sipId: text('sip_id').notNull(),
    leaveTypeId: integer('leave_type_id').notNull(),
    entryType: text('entry_type').$type<LedgerEntryType>().notNull(),
    /** signed: + grant, − taken */
    days: doublePrecision('days').notNull(),
    entryDate: day('entry_date').notNull(),
    /** e.g. 'leave_application:12', 'accrual:2026' */
    reference: text('reference'),
    note: text('note'),
    balanceAfter: doublePrecision('balance_after').notNull(),
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'leave_ledger_employee_fk', columns: [t.companyId, t.sipId], foreignColumns: [employees.companyId, employees.sipId] }).onUpdate('cascade'),
    foreignKey({ name: 'leave_ledger_type_fk', columns: [t.companyId, t.leaveTypeId], foreignColumns: [leaveTypes.companyId, leaveTypes.id] }),
    index('leave_ledger_sip_type_idx').on(t.companyId, t.sipId, t.leaveTypeId, t.id),
    uniqueIndex('leave_ledger_reference_uq').on(t.companyId, t.sipId, t.leaveTypeId, t.reference),
  ],
);

export const leaveApplications = pgTable(
  'leave_applications',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    sipId: text('sip_id').notNull(),
    leaveTypeId: integer('leave_type_id').notNull(),
    startDate: day('start_date').notNull(),
    endDate: day('end_date').notNull(),
    totalDays: doublePrecision('total_days').notNull(),
    /** days that reduce pay: all of an unpaid type, or the part beyond the balance */
    unpaidDays: doublePrecision('unpaid_days').notNull().default(0),
    halfDay: boolean('half_day').notNull().default(false),
    reason: text('reason'),
    attachmentName: text('attachment_name'),
    attachmentStored: text('attachment_stored'),
    status: text('status').$type<LeaveStatus>().notNull().default('pending'),
    approverId: integer('approver_id').references((): AnyPgColumn => users.id),
    decisionComment: text('decision_comment'),
    decidedAt: ts('decided_at'),
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'leave_apps_employee_fk', columns: [t.companyId, t.sipId], foreignColumns: [employees.companyId, employees.sipId] }).onUpdate('cascade'),
    foreignKey({ name: 'leave_apps_type_fk', columns: [t.companyId, t.leaveTypeId], foreignColumns: [leaveTypes.companyId, leaveTypes.id] }),
    index('leave_apps_sip_idx').on(t.companyId, t.sipId),
    index('leave_apps_status_idx').on(t.companyId, t.status),
    index('leave_apps_dates_idx').on(t.companyId, t.startDate, t.endDate),
  ],
);

/* ------------------------------------------------------------------ */
/* Integrations: API keys, events, webhooks                             */
/* ------------------------------------------------------------------ */

/**
 * Keys for other systems. The full key is shown once; only its SHA-256 is
 * kept. A key acts in its company with exactly the permissions in `scopes`.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    name: text('name').notNull(),
    /** public part of the key, used to find it: hrms_<prefix>_… */
    prefix: text('prefix').notNull().unique(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    createdBy: integer('created_by')
      .notNull()
      .references((): AnyPgColumn => users.id),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('api_keys_company_idx').on(t.companyId)],
);

/**
 * The event outbox: one row per state change worth telling other systems
 * about, written in the same transaction as the change. Webhooks, the
 * WebSocket stream and the polling feed all read from here.
 */
export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    /** e.g. 'employee.created', 'leave_application.approved' */
    type: text('type').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    /** permission a reader needs to see this event (by module) */
    module: text('module').notNull(),
    data: jsonb('data').notNull(),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
  },
  (t) => [index('events_company_id_idx').on(t.companyId, t.id), index('events_id_idx').on(t.id)],
);

export const webhooks = pgTable(
  'webhooks',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    /** HMAC secret for the X-HRMS-Signature header; shown once */
    secret: text('secret').notNull(),
    /** event types or patterns: 'employee.*', 'leave_application.approved', '*' */
    events: text('events').array().notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
  },
  (t) => [unique('webhooks_company_id_uq').on(t.companyId, t.id)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    webhookId: integer('webhook_id').notNull(),
    eventId: integer('event_id').references(() => events.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    /** pending → delivered | failed (after the last retry) */
    status: text('status').$type<'pending' | 'delivered' | 'failed'>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    responseStatus: integer('response_status'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    deliveredAt: ts('delivered_at'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'webhook_deliveries_webhook_fk', columns: [t.companyId, t.webhookId], foreignColumns: [webhooks.companyId, webhooks.id] }).onDelete('cascade'),
    index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt),
    index('webhook_deliveries_hook_idx').on(t.companyId, t.webhookId, t.id),
  ],
);

/**
 * A person's accounts in other systems, e.g. their VICIdial agent username.
 * `context` tells apart systems with several instances (one VICIdial user
 * name can exist on two dialers); empty when not needed.
 */
export const employeeLinks = pgTable(
  'employee_links',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    sipId: text('sip_id').notNull(),
    /** 'vicidial', 'attendance', … lowercase */
    system: text('system').notNull(),
    externalId: text('external_id').notNull(),
    context: text('context').notNull().default(''),
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'employee_links_employee_fk', columns: [t.companyId, t.sipId], foreignColumns: [employees.companyId, employees.sipId] }).onUpdate('cascade'),
    // one account belongs to one person
    uniqueIndex('employee_links_external_uq').on(t.companyId, t.system, t.context, t.externalId),
    index('employee_links_sip_idx').on(t.companyId, t.sipId),
  ],
);

/**
 * Figures other systems report per person and period, e.g. VICIdial's monthly
 * QA score. One row per (person, source, metric, period); sending again updates it.
 */
export const employeeMetrics = pgTable(
  'employee_metrics',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    sipId: text('sip_id').notNull(),
    source: text('source').notNull(),
    /** 'qa_score', 'calls_handled', 'login_hours' … */
    metric: text('metric').notNull(),
    /** 'YYYY-MM' or 'YYYY-MM-DD' */
    period: text('period').notNull(),
    value: doublePrecision('value').notNull(),
    /** '%', 'hours', 'calls' … for display */
    unit: text('unit'),
    details: jsonb('details'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'employee_metrics_employee_fk', columns: [t.companyId, t.sipId], foreignColumns: [employees.companyId, employees.sipId] }).onUpdate('cascade'),
    uniqueIndex('employee_metrics_uq').on(t.companyId, t.sipId, t.source, t.metric, t.period),
  ],
);

/**
 * One sale credited to one person. A sale from a dialer usually gives two
 * rows with the same external_ref: the closer who made it and the fronter
 * whose transfer led to it. Voided rows stay for the record and earn nothing.
 * Monthly counts per role feed the sales incentive in payroll.
 */
export const sales = pgTable(
  'sales',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    sipId: text('sip_id').notNull(),
    /** 'closer' made the sale, 'fronter' transferred the call that became it */
    role: text('role').notNull(),
    saleDate: date('sale_date', { mode: 'string' }).notNull(),
    /** 'manual', or the system that reported it ('vicidial') */
    source: text('source').notNull().default('manual'),
    context: text('context').notNull().default(''),
    /** the sale's id in the source system; null for manual entries */
    externalRef: text('external_ref'),
    /** the account that system credited, e.g. the agent user */
    externalUser: text('external_user'),
    /** customer, policy or lead number, as the team knows the sale */
    reference: text('reference'),
    /** sale value in PKR, when known; not used for incentives */
    amount: integer('amount'),
    note: text('note'),
    /** 'confirmed' | 'void' */
    status: text('status').notNull().default('confirmed'),
    voidReason: text('void_reason'),
    /** set when a person voided it, so a later sync from the source never restores it */
    voidedBy: integer('voided_by').references((): AnyPgColumn => users.id),
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'sales_employee_fk', columns: [t.companyId, t.sipId], foreignColumns: [employees.companyId, employees.sipId] }).onUpdate('cascade'),
    // a source's sale is stored once per role; manual rows (null ref) never collide
    uniqueIndex('sales_external_uq').on(t.companyId, t.source, t.context, t.externalRef, t.role),
    index('sales_date_idx').on(t.companyId, t.saleDate),
    index('sales_sip_date_idx').on(t.companyId, t.sipId, t.saleDate),
  ],
);

/**
 * Diagnostics log for the remote ops endpoints (routes/ops.ts): warnings and
 * errors, background job reports and boots. Platform-wide, written and read
 * only by the owner connection; requests (hrms_app) cannot reach it. Pruned
 * to 14 days.
 */
export const opsLog = pgTable(
  'ops_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    t: ts('t').notNull().defaultNow(),
    /** 'info' | 'warn' | 'error' | 'fatal' | 'boot' */
    lvl: text('lvl').notNull(),
    msg: text('msg').notNull(),
    ctx: jsonb('ctx'),
  },
  (t) => [index('ops_log_t_idx').on(t.t), index('ops_log_lvl_t_idx').on(t.lvl, t.t)],
);

/** Tables that belong to a company and are row-secured (migrations 0002, 0004, 0005, 0006). */
export const TENANT_TABLES = [
  'roles',
  'users',
  'audit_trail',
  'notifications',
  'settings',
  'sip_counters',
  'stored_files',
  'departments',
  'designations',
  'candidates',
  'applications',
  'stage_history',
  'interviews',
  'communications',
  'employees',
  'employee_documents',
  'salary_structures',
  'payroll_runs',
  'payslips',
  'payslip_lines',
  'loans_advances',
  'leave_types',
  'leave_ledger',
  'leave_applications',
  'api_keys',
  'events',
  'webhooks',
  'webhook_deliveries',
  'employee_links',
  'employee_metrics',
  'sales',
] as const;
