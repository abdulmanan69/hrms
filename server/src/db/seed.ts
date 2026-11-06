/**
 * Runs at every boot, idempotent:
 * - an empty database gets its first company (COMPANY_NAME / COMPANY_SLUG)
 *   and the first super admin (ADMIN_EMAIL / ADMIN_PASSWORD);
 * - every company gets its base data (roles, settings, leave types, departments);
 * - with SEED_DEMO=true, sample data loads once into an empty database:
 *   two companies, so the separation between them can be seen.
 */
import { asc, count, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';

const DEFAULT_ADMIN_PASSWORD = 'ChangeMe123!';
import { setupCompany } from '../services/companySetup.js';
import { db, rootDb, runInCompany } from './client.js';
import { companies, employees, roles, users } from './schema.js';
import { seedDemo } from './seedDemo.js';

export async function seed(): Promise<void> {
  let list = await rootDb.select().from(companies).orderBy(asc(companies.id));
  const freshInstall = list.length === 0;
  if (freshInstall) {
    await rootDb.insert(companies).values({ name: config.COMPANY_NAME, slug: config.COMPANY_SLUG });
    list = await rootDb.select().from(companies).orderBy(asc(companies.id));
  }

  for (const c of list) await runInCompany(c.id, () => setupCompany(c.name));

  // the first company always has a super admin
  const first = list[0];
  const [{ n: superAdmins }] = await rootDb.select({ n: count() }).from(users).where(eq(users.isSuperAdmin, true));
  if (superAdmins === 0) {
    await runInCompany(first.id, async () => {
      const [existing] = await db.select().from(users).where(eq(users.email, config.ADMIN_EMAIL.toLowerCase()));
      if (existing) {
        // an install from before companies: its admin becomes the super admin
        await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, existing.id));
        console.log(`${existing.email} is now the super admin`);
      } else {
        if (config.NODE_ENV === 'production' && config.ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD) {
          throw new Error('Set ADMIN_PASSWORD in .env before the first start: the default password is public');
        }
        const [admin] = await db.select().from(roles).where(eq(roles.name, 'admin'));
        await db.insert(users).values({
          email: config.ADMIN_EMAIL.toLowerCase(),
          name: 'HR admin',
          roleId: admin.id,
          isSuperAdmin: true,
          passwordHash: await hashPassword(config.ADMIN_PASSWORD),
        });
        console.log(`Created the super admin: ${config.ADMIN_EMAIL}`);
      }
    });
  }

  // a super admin still signing in with the public default password is a takeover waiting to happen
  const admins = await rootDb.select({ email: users.email, hash: users.passwordHash }).from(users).where(eq(users.isSuperAdmin, true));
  for (const a of admins) {
    if (await verifyPassword(DEFAULT_ADMIN_PASSWORD, a.hash)) {
      console.warn(`SECURITY: ${a.email} still uses the default password. Sign in and change it (top right → Change password).`);
    }
  }

  if (config.SEED_DEMO) {
    const [{ n: anyStaff }] = await rootDb.select({ n: count() }).from(employees);
    if (anyStaff === 0) await seedDemo(first.id);
  }
}
