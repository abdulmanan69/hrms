/**
 * Remote diagnostics: read-only, behind OPS_TOKEN (sent as `x-ops-token`),
 * absent unless the token is set. Mounted at /api/v1/ops. Used by
 * scripts/ops.mjs.
 *
 *   GET /ops/status     health at a glance and a list of problems
 *   GET /ops/errors     warnings and errors, grouped (?since=24h&list=1)
 *   GET /ops/logs       everything logged (?since=1h&grep=&level=)
 *   GET /ops/requests   API timing per minute and route, slow requests
 *   GET /ops/db         connections, running queries, table sizes
 *
 * Nothing here returns people's records: only counts, timings and log lines
 * (with secrets masked). There is deliberately no SQL endpoint.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, rootDb } from '../db/client.js';
import { UnauthorizedError } from '../lib/errors.js';
import { jobState, processReport, requestReport, requestSummary } from '../lib/opsLog.js';

const platform = { platform: true, rateLimit: { max: 120, timeWindow: '1 minute' } };

function ipAllowed(ip: string): boolean {
  const list = config.OPS_ALLOWED_IPS.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  const v4 = (s: string) => s.replace(/^::ffff:/, '').split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  return list.some((entry) => {
    if (!entry.includes('/')) return entry === ip || entry === ip.replace(/^::ffff:/, '');
    const [base, bits] = entry.split('/');
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(base) || !/^\d+\.\d+\.\d+\.\d+$/.test(ip.replace(/^::ffff:/, ''))) return false;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (v4(base) & mask) === (v4(ip) & mask);
  });
}

function checkToken(req: FastifyRequest): void {
  const given = Buffer.from(String(req.headers['x-ops-token'] ?? ''));
  const want = Buffer.from(config.OPS_TOKEN);
  if (!ipAllowed(req.ip) || given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new UnauthorizedError('Diagnostics token missing or wrong');
  }
}

/** '15m', '24h', '7d' → an interval string; capped at 14 days */
const since = z
  .string()
  .regex(/^\d{1,4}[mhd]$/, 'since is like 30m, 6h or 7d')
  .default('24h')
  .transform((v) => {
    const n = Number(v.slice(0, -1));
    const unit = v.endsWith('m') ? 'minutes' : v.endsWith('h') ? 'hours' : 'days';
    const minutes = unit === 'minutes' ? n : unit === 'hours' ? n * 60 : n * 1440;
    return `${Math.min(minutes, 14 * 1440)} minutes`;
  });

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return (await rootDb.execute(q)).rows as T[];
}

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  if (!config.OPS_TOKEN) return;
  app.addHook('onRequest', async (req) => checkToken(req));

  app.get('/status', { config: platform }, async () => {
    const t0 = performance.now();
    const [dbInfo] = await rows<{ size: string; connections: number; version: string }>(
      sql`select pg_size_pretty(pg_database_size(current_database())) as size,
                 (select count(*)::int from pg_stat_activity where datname = current_database()) as connections,
                 split_part(version(), ' ', 2) as version`,
    );
    const dbMs = Math.round(performance.now() - t0);
    const [migrations] = await rows<{ applied: number; last: string | null }>(
      sql`select count(*)::int as applied, max(to_timestamp(created_at / 1000))::text as last from drizzle.__drizzle_migrations`,
    ).catch(() => [{ applied: -1, last: null }]);
    const companies = await rows<{ id: number; slug: string; status: string; employees: number; active: number; users: number; signedIn24h: number }>(sql`
      select c.id, c.slug, c.status,
        (select count(*)::int from employees e where e.company_id = c.id) as employees,
        (select count(*)::int from employees e where e.company_id = c.id and e.status = 'active') as active,
        (select count(*)::int from users u where u.company_id = c.id and u.status = 'active') as users,
        (select count(*)::int from users u where u.company_id = c.id and u.last_login_at > now() - interval '24 hours') as "signedIn24h"
      from companies c order by c.id`);
    const [webhooks] = await rows<{ pending: number; due: number; oldestPendingMin: number | null; failed24h: number; delivered24h: number }>(sql`
      select count(*) filter (where status = 'pending')::int as pending,
             count(*) filter (where status = 'pending' and next_attempt_at <= now())::int as due,
             round(extract(epoch from now() - min(created_at) filter (where status = 'pending')) / 60)::int as "oldestPendingMin",
             count(*) filter (where status = 'failed' and created_at > now() - interval '24 hours')::int as failed24h,
             count(*) filter (where status = 'delivered' and delivered_at > now() - interval '24 hours')::int as delivered24h
      from webhook_deliveries`);
    const [integrations] = await rows<{ keys: number; keysUsed24h: number; events24h: number; links: number; sales24h: number; metrics24h: number }>(sql`
      select (select count(*)::int from api_keys where revoked_at is null) as keys,
             (select count(*)::int from api_keys where revoked_at is null and last_used_at > now() - interval '24 hours') as "keysUsed24h",
             (select count(*)::int from events where occurred_at > now() - interval '24 hours') as events24h,
             (select count(*)::int from employee_links) as links,
             (select count(*)::int from sales where updated_at > now() - interval '24 hours') as sales24h,
             (select count(*)::int from employee_metrics where updated_at > now() - interval '24 hours') as metrics24h`);
    const [logs] = await rows<{ errors1h: number; errors24h: number; warns24h: number; boots24h: number }>(sql`
      select count(*) filter (where lvl in ('error','fatal') and t > now() - interval '1 hour')::int as errors1h,
             count(*) filter (where lvl in ('error','fatal'))::int as errors24h,
             count(*) filter (where lvl = 'warn')::int as warns24h,
             count(*) filter (where lvl = 'boot')::int as boots24h
      from ops_log where t > now() - interval '24 hours'`);
    const boots = await rows<{ t: string; ctx: unknown }>(sql`select t, ctx from ops_log where lvl = 'boot' order by t desc limit 5`);

    const req = requestSummary(15);
    const proc = processReport();
    const poolState = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: config.DB_POOL_MAX };

    const problems: string[] = [];
    if (dbMs > 250) problems.push(`Database answered slowly (${dbMs} ms)`);
    if (poolState.waiting > 0) problems.push(`${poolState.waiting} requests waiting for a database connection (pool ${poolState.max})`);
    if (req.s5xx > 0) problems.push(`${req.s5xx} server errors (5xx) in the last 15 minutes`);
    if (logs.errors1h > 0) problems.push(`${logs.errors1h} errors logged in the last hour (ops errors)`);
    if (req.p95Ms > 1500) problems.push(`Slow API: p95 ${req.p95Ms} ms over the last 15 minutes`);
    if (webhooks.due > 50) problems.push(`${webhooks.due} webhook deliveries overdue`);
    if (webhooks.failed24h > 0) problems.push(`${webhooks.failed24h} webhook deliveries gave up in the last 24 hours`);
    if (logs.boots24h > 3) problems.push(`API started ${logs.boots24h} times in 24 hours (crash loop?)`);
    if (proc.eventLoopP99Ms > 200) problems.push(`Event loop lag p99 ${proc.eventLoopP99Ms} ms`);
    if (proc.rssMb > 768) problems.push(`High memory: ${proc.rssMb} MB`);
    for (const [name, s] of Object.entries(jobState)) {
      if (s.lastError && (!s.lastOk || s.lastError > s.lastOk)) problems.push(`Job ${name} failed on its last run (${s.lastError})`);
    }

    return {
      at: new Date().toISOString(),
      build: { commit: config.SOURCE_COMMIT || null, env: config.NODE_ENV, tz: config.TZ_BUSINESS },
      process: proc,
      db: { ms: dbMs, ...dbInfo, pool: poolState, migrations },
      requests: req,
      jobs: jobState,
      webhooks,
      integrations,
      logs,
      boots,
      companies,
      problems,
    };
  });

  app.get('/errors', { config: platform }, async (req) => {
    const q = z.object({ since, list: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    if (q.list) {
      return {
        errors: await rows(sql`select t, lvl, msg, ctx from ops_log where lvl in ('warn','error','fatal') and t > now() - ${q.since}::interval order by t desc limit ${q.limit}`),
      };
    }
    return {
      groups: await rows(sql`
        select lvl, msg, count(*)::int as count, min(t) as first, max(t) as last,
               (array_agg(ctx order by t desc))[1] as "latestCtx"
        from ops_log where lvl in ('warn','error','fatal') and t > now() - ${q.since}::interval
        group by lvl, msg order by max(t) desc limit ${q.limit}`),
    };
  });

  app.get('/logs', { config: platform }, async (req) => {
    const q = z
      .object({
        since: since.default('1h'),
        grep: z.string().trim().max(100).optional(),
        level: z.enum(['info', 'warn', 'error', 'boot']).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
      })
      .parse(req.query);
    const like = q.grep ? `%${q.grep.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    return {
      logs: await rows(sql`
        select t, lvl, msg, ctx from ops_log
        where t > now() - ${q.since}::interval
          ${q.level ? sql`and lvl = ${q.level}` : sql``}
          ${like ? sql`and (msg ilike ${like} or ctx::text ilike ${like})` : sql``}
        order by t desc limit ${q.limit}`),
    };
  });

  app.get('/requests', { config: platform }, async () => requestReport());

  app.get('/db', { config: platform }, async () => ({
    connections: await rows(sql`
      select coalesce(state, 'background') as state, usename as "user", count(*)::int as count,
             max(extract(epoch from now() - coalesce(xact_start, query_start)))::int as "oldestSec"
      from pg_stat_activity where datname = current_database() group by 1, 2 order by 3 desc`),
    running: await rows(sql`
      select pid, state, extract(epoch from now() - query_start)::int as sec, wait_event_type as wait, left(query, 200) as query
      from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'
      order by query_start limit 20`),
    tables: await rows(sql`
      select relname as table, n_live_tup::bigint as rows, pg_size_pretty(pg_total_relation_size(relid)) as size,
             seq_scan::bigint as "seqScans", idx_scan::bigint as "indexScans"
      from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 30`),
  }));
}
