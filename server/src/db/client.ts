/**
 * Database access, scoped to one company at a time.
 *
 * - `db` is what every module uses. It resolves to the transaction of the
 *   current company context (see runInCompany). Inside that transaction the
 *   connection runs as the restricted role `hrms_app` with `app.company_id`
 *   set, so Postgres row-level security returns and accepts only that
 *   company's rows, and new rows default to that company. Using `db` outside
 *   a company context throws: no query can silently see every company.
 * - `rootDb` is the table owner, unrestricted. Only sign-in, sessions,
 *   migrations, the platform company list and the job scheduler use it.
 *
 * Both settings are transaction-local (`set_config(..., true)`), so they end
 * at COMMIT/ROLLBACK and can never carry over to the next request that gets
 * the same pooled connection.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';

// DATE columns stay plain 'YYYY-MM-DD' strings, never JS Dates shifted by time zone.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  // under overload, fail a request after 10 s instead of queueing it forever
  connectionTimeoutMillis: 10_000,
  // a stuck query must not hold a connection (and the request) forever
  statement_timeout: 30_000,
  idle_in_transaction_session_timeout: 60_000,
});

// A connection Postgres closes (restart, timeout) must never crash the API:
// log it; the pool drops the client and the request using it fails cleanly.
pool.on('error', (err) => console.error('database connection lost (idle):', err.message));
pool.on('connect', (client) => {
  client.on('error', (err) => console.error('database connection lost:', err.message));
});

/** Unrestricted owner connection. Platform code only. */
export const rootDb = drizzle(pool, { schema });

export type Db = typeof rootDb;
/** A transaction handle; services accept either this or `db`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

interface CompanyContext {
  tx: Tx;
  companyId: number;
}
const context = new AsyncLocalStorage<CompanyContext>();

/** The company of the running request or job, or null outside one. */
export function currentCompanyId(): number | null {
  return context.getStore()?.companyId ?? null;
}

/**
 * Runs `fn` in one transaction bound to `companyId`. Everything inside, `db`
 * included, sees and writes only that company's rows. Nested calls for the
 * same company reuse the transaction; a different company is refused.
 */
export async function runInCompany<T>(companyId: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error(`Invalid company id: ${companyId}`);
  const outer = context.getStore();
  if (outer) {
    if (outer.companyId !== companyId) throw new Error('A company context cannot open another company');
    return fn(outer.tx);
  }
  return rootDb.transaction(async (tx) => {
    // one round trip: pin the company and drop to the row-secured role
    await tx.execute(sql`select set_config('app.company_id', ${String(companyId)}, true), set_config('role', 'hrms_app', true)`);
    return context.run({ tx, companyId }, () => fn(tx));
  });
}

/**
 * The company-scoped database. Same API as a drizzle instance; resolves to the
 * current company's transaction at call time.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const store = context.getStore();
    if (!store) {
      throw new Error(`Database used outside a company context (db.${String(prop)}). Wrap the work in runInCompany, or use rootDb for platform queries.`);
    }
    const value = (store.tx as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(store.tx) : value;
  },
});

export async function closeDb(): Promise<void> {
  await pool.end();
}
