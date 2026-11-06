/**
 * Recruitment rules shared by the routes: stage → status derivation, stage
 * moves (history + audit), candidate validation and duplicate detection, and
 * the hire action that converts a candidate into an employee.
 *
 * Status is derived from the stage, with one exception: "Reject" closes an
 * application at whatever stage it reached. The stage stays (so the record
 * shows how far the person got), status becomes 'rejected', and a
 * stage_history row with from = to = current stage and a "Rejected" note is
 * written. Moving a rejected application to another stage reopens it and
 * re-derives the status from the new stage.
 */
import { and, eq, isNull, ne, or, sql, type SQLWrapper } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { DbOrTx } from '../db/client.js';
import {
  applications,
  candidates,
  stageHistory,
  type ApplicationStatus,
  type PipelineStage,
} from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { ConflictError, ValidationError } from '../lib/errors.js';
import { fullName } from './people.js';

export const STATUS_FOR_STAGE: Record<PipelineStage, ApplicationStatus> = {
  application_received: 'pending',
  screening: 'screening',
  interview_scheduled: 'interviewed',
  interview_completed: 'interviewed',
  feedback_received: 'interviewed',
  offer_made: 'offered',
  offer_accepted: 'offered',
  offer_rejected: 'rejected',
  hired: 'hired',
  onboarding: 'hired',
};

/** Columns of the pipeline board, in order. */
export const BOARD_STAGES: PipelineStage[] = [
  'application_received',
  'screening',
  'interview_scheduled',
  'interview_completed',
  'feedback_received',
  'offer_made',
  'offer_accepted',
];

/** Closed applications: no longer on the board. */
export const CLOSED_STATUSES: ApplicationStatus[] = ['rejected', 'hired'];

export function stageLabel(stage: string): string {
  const s = stage.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function candidateCode(id: number): string {
  return `C-${String(id).padStart(5, '0')}`;
}

/** "C-00012", "c12", "12" → 12 */
export function parseCandidateCode(s: string): number | null {
  const m = /^\s*(?:c-?)?0*(\d{1,9})\s*$/i.exec(s);
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** Phone: digits with optional + ( ) - . and spaces, 7–15 digits, no letters. */
export const phoneSchema = z.preprocess(
  blankToNull,
  z
    .string()
    .trim()
    .refine((v) => /^\+?[\d\s().-]+$/.test(v), 'must be a phone number (digits, spaces, + ( ) - only), not an address')
    .refine((v) => {
      const n = v.replace(/\D/g, '').length;
      return n >= 7 && n <= 15;
    }, 'must have 7 to 15 digits')
    .refine((v) => v.length <= 30, 'is too long')
    .nullable()
    .optional(),
);

/** Postal code is text: a number would lose leading zeros (07087 → 7087). */
export const postalSchema = z.preprocess(
  blankToNull,
  z
    .string({ invalid_type_error: 'must be text so leading zeros are kept' })
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/, 'must be 2–10 letters, digits, spaces or dashes')
    .nullable()
    .optional(),
);

/** Pakistani CNIC 12345-1234567-1, stored with dashes. */
export const cnicSchema = z.preprocess(
  blankToNull,
  z
    .string()
    .trim()
    .regex(/^\d{5}-?\d{7}-?\d$/, 'must be 13 digits, e.g. 35202-1234567-1')
    .transform((v) => {
      const d = v.replace(/\D/g, '');
      return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
    })
    .nullable()
    .optional(),
);

const optText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date YYYY-MM-DD');
export const optDate = z.preprocess(blankToNull, isoDate.nullable().optional());

export const candidateFields = {
  firstName: z.string().trim().min(1, 'is required').max(60),
  middleInitial: z.preprocess(blankToNull, z.string().trim().max(2).nullable().optional()),
  lastName: z.string().trim().min(1, 'is required').max(60),
  email: z.preprocess(
    blankToNull,
    z
      .string()
      .trim()
      .toLowerCase()
      .email('must be a valid email address')
      .max(160)
      .nullable()
      .optional(),
  ),
  phone: phoneSchema,
  altPhone: phoneSchema,
  address1: optText(160),
  address2: optText(160),
  city: optText(80),
  state: optText(80),
  postalCode: postalSchema,
  country: optText(80),
  gender: z.preprocess(blankToNull, z.enum(['male', 'female', 'other']).nullable().optional()),
  dateOfBirth: optDate,
  cnic: cnicSchema,
  source: optText(80),
  notes: optText(4000),
};

/* ------------------------------------------------------------------ */
/* Duplicates                                                          */
/* ------------------------------------------------------------------ */

const digitsSql = (col: SQLWrapper) => sql`regexp_replace(coalesce(${col}, ''), '\\D', '', 'g')`;

/** An existing candidate with the same email or phone (last 10 digits), if any. */
export async function findDuplicate(
  tx: DbOrTx,
  input: { email?: string | null; phone?: string | null },
  excludeId?: number,
): Promise<{ id: number; name: string; matchedOn: 'email' | 'phone' } | null> {
  const conds = [];
  const email = input.email?.trim().toLowerCase();
  if (email) conds.push(sql`lower(${candidates.email}) = ${email}`);
  const digits = input.phone?.replace(/\D/g, '') ?? '';
  if (digits.length >= 7) {
    const tail = digits.slice(-10);
    conds.push(sql`right(${digitsSql(candidates.phone)}, 10) = ${tail}`);
    conds.push(sql`right(${digitsSql(candidates.altPhone)}, 10) = ${tail}`);
  }
  if (conds.length === 0) return null;
  const [row] = await tx
    .select()
    .from(candidates)
    .where(and(isNull(candidates.deletedAt), excludeId ? ne(candidates.id, excludeId) : undefined, or(...conds)))
    .limit(1);
  if (!row) return null;
  return { id: row.id, name: fullName(row), matchedOn: email && row.email?.toLowerCase() === email ? 'email' : 'phone' };
}

/* ------------------------------------------------------------------ */
/* Stage moves                                                         */
/* ------------------------------------------------------------------ */

type AppRow = typeof applications.$inferSelect;
type CandidateRow = typeof candidates.$inferSelect;

/**
 * Moves an application to a stage: updates stage + derived status, writes
 * stage_history and an audit row. Callers check that the move is allowed.
 */
export async function applyStage(
  tx: DbOrTx,
  req: FastifyRequest,
  app: AppRow,
  cand: CandidateRow,
  to: PipelineStage,
  note: string | null,
  extra: Partial<Pick<AppRow, 'hiredSipId'>> = {},
  summary?: string,
): Promise<AppRow> {
  const [after] = await tx
    .update(applications)
    .set({ currentStage: to, status: STATUS_FOR_STAGE[to], updatedAt: new Date(), ...extra })
    .where(eq(applications.id, app.id))
    .returning();
  await tx.insert(stageHistory).values({
    applicationId: app.id,
    fromStage: app.currentStage,
    toStage: to,
    note,
    userId: req.auth.userId,
  });
  await writeAudit(tx, req, {
    action: 'stage_change',
    entity: 'application',
    entityId: app.id,
    summary: summary ?? `moved ${fullName(cand)} to ${stageLabel(to)}`,
    before: { stage: app.currentStage, status: app.status },
    after: { stage: after.currentStage, status: after.status, note },
  });
  return after;
}

/** Rules for a manual stage move (drag on the board, "Move stage"). */
export function assertMoveAllowed(app: AppRow, to: PipelineStage): void {
  if (app.currentStage === to && app.status !== 'rejected') throw new ValidationError(`Already at ${stageLabel(to)}`);
  if (to === 'hired') throw new ValidationError('Use Hire to move a candidate to Hired; it creates the employee record');
  if (app.status === 'hired') {
    if (app.currentStage === 'hired' && to === 'onboarding') return;
    throw new ConflictError('This candidate is already hired; the stage can only move from Hired to Onboarding');
  }
  if (to === 'onboarding') throw new ValidationError('Only a hired candidate can move to Onboarding');
}
