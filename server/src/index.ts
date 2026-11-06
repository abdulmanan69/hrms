import { asc, eq } from 'drizzle-orm';
import { config } from './config.js';
import { buildApp } from './app.js';
import { runMigrations } from './db/migrate.js';
import { seed } from './db/seed.js';
import { closeDb, rootDb, runInCompany } from './db/client.js';
import { companies } from './db/schema.js';
import { moveDiskUploadsToDb } from './lib/uploads.js';
import { todayISO } from './lib/dates.js';
import { accrueAll } from './services/leaveLedger.js';
import { startWebhookWorker } from './services/webhooks.js';
import { jobRan, opsRecord, startOpsLog } from './lib/opsLog.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };

/** Active companies, one id at a time: background work never spans companies in one transaction. */
async function activeCompanyIds(): Promise<number[]> {
  const rows = await rootDb.select({ id: companies.id }).from(companies).where(eq(companies.status, 'active')).orderBy(asc(companies.id));
  return rows.map((r) => r.id);
}

/**
 * Leave accrual is idempotent (every grant has a unique reference), so the
 * job runs at boot and then every 6 hours, company by company, each in its
 * own short transaction. A run never overlaps the previous one.
 */
function scheduleAccruals(log: Log): NodeJS.Timeout {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    let ok = true;
    let total = 0;
    try {
      for (const id of await activeCompanyIds()) {
        try {
          const written = await runInCompany(id, (tx) => accrueAll(tx, todayISO()));
          total += written;
          if (written > 0) log.info({ companyId: id, written }, 'leave accruals written');
        } catch (err) {
          ok = false;
          log.error({ err, companyId: id }, 'leave accrual failed for a company');
        }
      }
    } catch (err) {
      ok = false;
      log.error({ err }, 'leave accrual run failed');
    } finally {
      jobRan('leave-accrual', ok, `${total} grants written`);
      running = false;
    }
  };
  void run();
  return setInterval(run, 6 * 3600 * 1000);
}

// a crash is recorded before the process dies, so diagnostics can show why it restarted
let stopOpsLog: (() => Promise<void>) | null = null;
for (const ev of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(ev, (err) => {
    console.error(`${ev}:`, err);
    opsRecord('fatal', `${ev}: ${err instanceof Error ? err.message : String(err)}`, { err });
    void (stopOpsLog?.() ?? Promise.resolve()).finally(() => process.exit(1));
  });
}

async function main(): Promise<void> {
  await runMigrations();
  stopOpsLog = startOpsLog();
  await seed();

  const app = await buildApp();
  for (const id of await activeCompanyIds()) {
    await runInCompany(id, () => moveDiskUploadsToDb(app.log)).catch((err) => app.log.warn({ err, companyId: id }, 'moving old uploads failed'));
  }
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  opsRecord('boot', 'API started', { commit: config.SOURCE_COMMIT || null, node: process.version, pool: config.DB_POOL_MAX });
  const timer = scheduleAccruals(app.log);
  const stopWebhooks = startWebhookWorker(app.log);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(timer);
    stopWebhooks();
    await app.close();
    await stopOpsLog?.();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
