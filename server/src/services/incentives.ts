/**
 * Sales incentive for one person and month, from the number of confirmed
 * sales and the role's slab plan. Pure: no database.
 *
 *   reached  every sale at the rate of the highest slab reached
 *            (12 sales, slabs 1→300, 10→500: 12 × 500 = 6,000)
 *   stepped  each sale at the rate of its own slab
 *            (12 sales: 9 × 300 + 3 × 500 = 4,200)
 */
import type { IncentivePlan } from './settings.js';

export interface IncentiveStep {
  from: number;
  /** last sale number in this slab; null = no ceiling */
  to: number | null;
  rate: number;
  /** sales paid at this rate */
  count: number;
  amount: number;
}

export interface IncentiveResult {
  sales: number;
  amount: number;
  /** the slab reached, null below target */
  slab: { from: number; rate: number } | null;
  steps: IncentiveStep[];
  /** sales still needed for the next slab, null at the top */
  toNext: number | null;
}

export function sortedSlabs(plan: IncentivePlan) {
  return [...plan.slabs].filter((s) => s.from >= 1 && s.rate >= 0).sort((a, b) => a.from - b.from);
}

export function computeIncentive(sales: number, plan: IncentivePlan): IncentiveResult {
  const slabs = sortedSlabs(plan);
  const n = Math.max(0, Math.floor(sales));
  const reachedIdx = slabs.reduce((idx, s, i) => (n >= s.from ? i : idx), -1);
  const next = slabs[reachedIdx + 1];
  const toNext = next ? next.from - n : null;
  if (reachedIdx < 0) return { sales: n, amount: 0, slab: null, steps: [], toNext };

  const reached = slabs[reachedIdx];
  let steps: IncentiveStep[];
  if (plan.mode === 'reached') {
    steps = [{ from: reached.from, to: next ? next.from - 1 : null, rate: reached.rate, count: n, amount: n * reached.rate }];
  } else {
    steps = slabs.slice(0, reachedIdx + 1).map((s, i) => {
      const upper = slabs[i + 1] ? slabs[i + 1].from - 1 : null;
      const top = upper === null ? n : Math.min(n, upper);
      const count = Math.max(0, top - s.from + 1);
      return { from: s.from, to: upper, rate: s.rate, count, amount: count * s.rate };
    });
  }
  return {
    sales: n,
    amount: steps.reduce((t, s) => t + s.amount, 0),
    slab: { from: reached.from, rate: reached.rate },
    steps,
    toNext,
  };
}

export const ROLE_COMPONENT = { closer: 'Sales incentive', fronter: 'Fronter incentive' } as const;
export type SaleRole = keyof typeof ROLE_COMPONENT;
export const SALE_ROLES: SaleRole[] = ['closer', 'fronter'];
