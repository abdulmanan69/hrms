import 'dotenv/config';
import { z } from 'zod';

const bool = (def: 'true' | 'false') =>
  z
    .string()
    .default(def)
    .transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().default('postgres://hrms:hrms@localhost:5432/hrms'),
  /** proxies in front of the API whose X-Forwarded-For is trusted: 1 = nginx only, 2 = nginx behind a TLS proxy */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  /**
   * Webhooks may go to private network addresses (other apps on your LAN or in
   * the same Docker network) and plain http. Off by default: a webhook URL must
   * not be able to reach the database or cloud metadata endpoints.
   */
  WEBHOOK_ALLOW_PRIVATE: bool('false'),
  /** connections the API keeps open to Postgres; each request holds one for its duration */
  DB_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
  /** first company, created on an empty database */
  COMPANY_NAME: z.string().trim().min(1).default('WaveTech'),
  COMPANY_SLUG: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,32}$/, 'COMPANY_SLUG: 2–32 lowercase letters, digits or dashes')
    .default('wavetech'),
  SESSION_TTL_HOURS: z.coerce.number().default(12),
  /** false = Secure cookie only when the request came over HTTPS */
  COOKIE_SECURE: bool('false'),
  ADMIN_EMAIL: z.string().email().default('admin@wavetech.pk'),
  ADMIN_PASSWORD: z.string().min(8).default('ChangeMe123!'),
  /** Sample people, candidates, payroll history and leave. Off in production. */
  SEED_DEMO: bool('false'),
  /** Where employee documents and leave attachments are stored */
  UPLOAD_DIR: z.string().default('./uploads'),
  /** Largest upload accepted, in megabytes */
  UPLOAD_MAX_MB: z.coerce.number().default(10),
  /** IANA zone for "today" in leave and payroll dates */
  TZ_BUSINESS: z.string().default('Asia/Karachi'),
  /**
   * Remote diagnostics (routes/ops.ts, scripts/ops.mjs): a secret of 32+
   * characters turns on the read-only /api/v1/ops endpoints. Empty = off.
   */
  OPS_TOKEN: z
    .string()
    .default('')
    .refine((v) => v === '' || v.length >= 32, 'OPS_TOKEN: at least 32 characters, or empty to turn diagnostics off'),
  /** optional: only these IPs or IPv4 CIDR ranges may use /api/v1/ops (comma-separated) */
  OPS_ALLOWED_IPS: z.string().default(''),
  /** set by Coolify when "Include Source Commit in Build" is on; shown in diagnostics */
  SOURCE_COMMIT: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

