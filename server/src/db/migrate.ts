import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { rootDb as db, pool } from './client.js';

const MIGRATION_LOCK = 482_113_007;

/** Applies pending migrations under an advisory lock so parallel boots never race. */
export async function runMigrations(): Promise<void> {
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK})`);
  try {
    await migrate(db, { migrationsFolder: 'drizzle' });
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK})`);
  }
}

if (process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1])) {
  runMigrations()
    .then(() => {
      console.log('Migrations applied.');
      return pool.end();
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
