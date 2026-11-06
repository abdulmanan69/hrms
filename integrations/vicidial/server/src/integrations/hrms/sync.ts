/**
 * Jobs that keep the VICIdial QA platform and WaveTech HRMS in step.
 *
 *   pushQaScores()   monthly average QA score per agent → HRMS (metric qa_score, %)
 *   employeesFor()   HRMS employee details for a company's agents, cached 5 min
 *
 * Both are read-only on the QA side: nothing in the QA database is changed.
 */
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { companies, dialerServers, evaluations, viciAgents } from '../../db/schema.js';
import { hrmsFor, type HrmsPerson, type MetricItem } from './client.js';

/** 'dialer' = HRMS links tell apart equal user names by dialer name (HRMS_CONTEXT=dialer). */
const useDialerContext = () => process.env.HRMS_CONTEXT === 'dialer';

function monthStart(offset: number): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
}
const ym = (d: Date) => d.toISOString().slice(0, 7);

/**
 * Sends each agent's average QA score for the current and previous month to
 * the HRMS. Safe to run as often as you like: HRMS replaces the value for the
 * same agent and month. Returns what was sent per company.
 */
export async function pushQaScores(months = 2): Promise<Array<{ company: string; saved: number; unknown: string[] }>> {
  const result: Array<{ company: string; saved: number; unknown: string[] }> = [];
  const list = await db.select({ id: companies.id, slug: companies.slug }).from(companies).where(eq(companies.status, 'active'));
  for (const c of list) {
    const hrms = hrmsFor(c.slug);
    if (!hrms) continue;
    const items: MetricItem[] = [];
    for (let m = 0; m < months; m++) {
      const from = monthStart(-m);
      const to = monthStart(-m + 1);
      const rows = await db
        .select({
          viciUser: viciAgents.viciUser,
          dialer: dialerServers.name,
          avg: sql<string>`avg(${evaluations.percent})`,
          n: sql<number>`count(*)::int`,
          min: sql<string>`min(${evaluations.percent})`,
          max: sql<string>`max(${evaluations.percent})`,
        })
        .from(evaluations)
        .innerJoin(viciAgents, eq(evaluations.targetAgentId, viciAgents.id))
        .innerJoin(dialerServers, eq(viciAgents.dialerServerId, dialerServers.id))
        .where(
          and(
            eq(evaluations.companyId, c.id),
            eq(evaluations.status, 'completed'),
            isNotNull(evaluations.percent),
            gte(evaluations.completedAt, from),
            lt(evaluations.completedAt, to),
          ),
        )
        .groupBy(viciAgents.viciUser, dialerServers.name);
      for (const r of rows) {
        items.push({
          externalId: r.viciUser,
          context: useDialerContext() ? r.dialer : '',
          metric: 'qa_score',
          period: ym(from),
          value: Math.round(Number(r.avg) * 10) / 10,
          unit: '%',
          details: { evaluations: r.n, lowest: Number(r.min), highest: Number(r.max), dialer: r.dialer },
        });
      }
    }
    if (items.length === 0) continue;
    const r = await hrms.pushMetrics(items);
    result.push({ company: c.slug, ...r });
  }
  return result;
}

const cache = new Map<string, { at: number; people: Map<string, HrmsPerson> }>();
const CACHE_MS = 5 * 60_000;

/** Forget cached HRMS details for a company (call when an HRMS webhook arrives). */
export function forgetHrmsCache(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/**
 * HRMS details for the agents of one QA company, keyed by agent user:
 * real name, SIP ID, department, team lead, active or left, on leave today.
 * Returns an empty map when HRMS is not configured for the company.
 */
export async function employeesFor(companyId: string, agentUsers?: string[]): Promise<Map<string, HrmsPerson>> {
  const [c] = await db.select({ slug: companies.slug }).from(companies).where(eq(companies.id, companyId));
  const hrms = c ? hrmsFor(c.slug) : null;
  if (!hrms) return new Map();
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS && (!agentUsers || agentUsers.every((u) => hit.people.has(u)))) return hit.people;

  const users =
    agentUsers ??
    (await db.select({ u: viciAgents.viciUser }).from(viciAgents).where(and(eq(viciAgents.companyId, companyId), eq(viciAgents.active, true)))).map((r) => r.u);
  const people = await hrms.people(users);
  const merged = new Map([...(hit?.people ?? []), ...people]);
  cache.set(companyId, { at: Date.now(), people: merged });
  return merged;
}

/** QA agent ids whose linked employee has left, or is on leave today. Useful to skip them when assigning QA tasks. */
export async function unavailableAgents(companyId: string): Promise<{ left: string[]; onLeave: string[] }> {
  const people = await employeesFor(companyId);
  const left: string[] = [];
  const onLeave: string[] = [];
  for (const [user, p] of people) {
    if (!p.found) continue;
    if (p.employee.status === 'inactive') left.push(user);
    else if (p.employee.onLeaveToday) onLeave.push(user);
  }
  if (!left.length && !onLeave.length) return { left: [], onLeave: [] };
  const ids = await db
    .select({ id: viciAgents.id, u: viciAgents.viciUser })
    .from(viciAgents)
    .where(and(eq(viciAgents.companyId, companyId), inArray(viciAgents.viciUser, [...left, ...onLeave])));
  return {
    left: ids.filter((r) => left.includes(r.u)).map((r) => r.id),
    onLeave: ids.filter((r) => onLeave.includes(r.u)).map((r) => r.id),
  };
}
