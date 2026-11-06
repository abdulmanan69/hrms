import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { settings } from '../db/schema.js';
import { DEFAULT_ATTENDANCE, type AttendanceSettings } from './attendance.js';

/**
 * Payroll rules. Defaults follow common Pakistani practice and the Finance Act
 * 2025 salaried slabs; HR/finance must confirm them in Payroll settings before
 * the first real run (they are open questions in the system design).
 */
export interface PayrollSettings {
  /** employee Provident Fund share, percent of basic salary */
  pfPercentOfBasic: number;
  /** fixed monthly EOBI employee contribution, PKR */
  eobiEmployeeAmount: number;
  /**
   * Annual withholding tax slabs on taxable salary. For annual income in
   * (from, to]: tax = fixed + rate% × (income − from). `to` null = no ceiling.
   */
  whtSlabs: Array<{ from: number; to: number | null; fixed: number; rate: number }>;
  /** proration basis for section A */
  prorationBasis: 'calendar' | 'working';
}

export interface LeaveSettings {
  /** 0 = Sunday … 6 = Saturday; days that do not count as leave */
  weekendDays: number[];
  /** public holidays, 'YYYY-MM-DD'; not counted as leave */
  holidays: string[];
}

/** One slab: from this many sales in the month, PKR `rate` per sale. */
export interface IncentiveSlab {
  from: number;
  rate: number;
}

/**
 * How one role earns its monthly sales incentive. Sales below the first
 * slab's `from` earn nothing (the target).
 *   reached: every sale is paid at the rate of the highest slab reached
 *   stepped: each sale is paid at the rate of the slab it falls in
 */
export interface IncentivePlan {
  mode: 'reached' | 'stepped';
  slabs: IncentiveSlab[];
}

export interface IncentiveSettings {
  closer: IncentivePlan;
  fronter: IncentivePlan;
  /** add the incentive to payslips (section B) automatically */
  includeInPayroll: boolean;
}

export interface CompanySettings {
  name: string;
  currency: string;
}

export const DEFAULT_SETTINGS = {
  payroll: {
    pfPercentOfBasic: 8.33,
    eobiEmployeeAmount: 370,
    whtSlabs: [
      { from: 0, to: 600_000, fixed: 0, rate: 0 },
      { from: 600_000, to: 1_200_000, fixed: 0, rate: 1 },
      { from: 1_200_000, to: 2_200_000, fixed: 6_000, rate: 11 },
      { from: 2_200_000, to: 3_200_000, fixed: 116_000, rate: 23 },
      { from: 3_200_000, to: 4_100_000, fixed: 346_000, rate: 30 },
      { from: 4_100_000, to: null, fixed: 616_000, rate: 35 },
    ],
    prorationBasis: 'calendar',
  } satisfies PayrollSettings as PayrollSettings,
  leave: { weekendDays: [0, 6], holidays: [] } satisfies LeaveSettings as LeaveSettings,
  // no slabs = no incentive until HR sets the rates
  incentives: {
    closer: { mode: 'reached', slabs: [] },
    fronter: { mode: 'reached', slabs: [] },
    includeInPayroll: true,
  } satisfies IncentiveSettings as IncentiveSettings,
  company: { name: 'WaveTech', currency: 'PKR' } satisfies CompanySettings as CompanySettings,
  attendance: DEFAULT_ATTENDANCE as AttendanceSettings,
};

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
type SettingValue<K extends SettingKey> = (typeof DEFAULT_SETTINGS)[K];

export async function getSetting<K extends SettingKey>(tx: DbOrTx, key: K): Promise<SettingValue<K>> {
  const [row] = await tx.select().from(settings).where(eq(settings.key, key));
  return { ...DEFAULT_SETTINGS[key], ...((row?.value as object) ?? {}) } as SettingValue<K>;
}

export async function setSetting<K extends SettingKey>(
  tx: DbOrTx,
  key: K,
  value: SettingValue<K>,
  userId: number | null,
): Promise<void> {
  await tx
    .insert(settings)
    .values({ key, value, updatedBy: userId })
    .onConflictDoUpdate({ target: [settings.companyId, settings.key], set: { value, updatedBy: userId, updatedAt: new Date() } });
}
