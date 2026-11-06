/**
 * Diagnostics kept for the remote ops endpoints (routes/ops.ts).
 *
 * - Log lines: every warning and error, plus info lines from background work
 *   (accruals, webhooks, uploads), are copied from the app logger into the
 *   ops_log table, so they survive a crash or restart. Writes are batched
 *   once a second through the owner connection, never block a request and
 *   never throw; while the database is unreachable lines wait in a small
 *   buffer and the oldest are dropped.
 * - Request timing: per-minute counters and the latest slow requests, in
 *   memory (an hour of history).
 *
 * Secrets are masked before anything is stored.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { lt, sql } from 'drizzle-orm';
import { rootDb } from '../db/client.js';
import { opsLog } from '../db/schema.js';

export type OpsLevel = 'info' | 'warn' | 'error' | 'fatal' | 'boot';

const MAX_MSG = 2000;
const MAX_CTX = 4000;
const BUFFER_CAP = 1000;
const KEEP_DAYS = 14;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/([?&](?:pass|password|pwd|token|ticket|api_key|apikey|secret|key)=)[^&\s"'#]*/gi, '$1***'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"']+:)[^@\s/"']+@/gi, '$1***@'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1***'],
  [/\bhrms_[0-9a-f]{8}_[0-9a-f]{40}\b/g, 'hrms_***'],
  [/\bwhsec_[A-Za-z0-9]+/g, 'whsec_***'],
  [/("(?:password|passwordHash|currentPassword|newPassword|secret|token|cookie|authorization|cnic|accountNo)"\s*:\s*)"[^"]*"/gi, '$1"***"'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (+${s.length - n} chars)` : s);

function safeCtx(ctx: unknown): Record<string, unknown> | null {
  if (!ctx || typeof ctx !== 'object') return null;
  let text: string;
  try {
    text = JSON.stringify(ctx, (_k, v: unknown) => {
      if (v instanceof Error) {
        const e = v as Error & { code?: unknown };
        return { type: e.name, message: e.message, ...(e.code != null ? { code: e.code } : {}), stack: e.stack?.split('\n').slice(0, 8).join('\n') };
      }
      return v;
    });
  } catch {
    return { unserializable: true };
  }
  if (!text || text === '{}') return null;
  text = redactSecrets(text);
  if (text.length > MAX_CTX) return { truncated: clip(text, MAX_CTX) };
  return JSON.parse(text) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Log lines                                                            */
/* ------------------------------------------------------------------ */

type Row = { t: Date; lvl: OpsLevel; msg: string; ctx: Record<string, unknown> | null };
let buffer: Row[] = [];
let timer: NodeJS.Timeout | null = null;
let writing = false;

export function opsRecord(lvl: OpsLevel, msg: string, ctx?: unknown): void {
  try {
    buffer.push({ t: new Date(), lvl, msg: clip(redactSecrets(String(msg ?? '')), MAX_MSG), ctx: safeCtx(ctx) });
    if (buffer.length > BUFFER_CAP) buffer = buffer.slice(-BUFFER_CAP);
  } catch {
    /* diagnostics never break the app */
  }
}

async function flush(): Promise<void> {
  if (writing || buffer.length === 0) return;
  writing = true;
  const rows = buffer;
  buffer = [];
  try {
    await rootDb.insert(opsLog).values(rows);
  } catch {
    // database away: keep the lines for the next try, newest first to survive
    buffer = [...rows, ...buffer].slice(-BUFFER_CAP);
  } finally {
    writing = false;
  }
}

async function prune(): Promise<void> {
  try {
    await rootDb.delete(opsLog).where(lt(opsLog.t, sql`now() - make_interval(days => ${KEEP_DAYS})`));
  } catch {
    /* next hour */
  }
}

/** Starts the batched writer and the daily prune. Returns a stop function that flushes what is left. */
export function startOpsLog(): () => Promise<void> {
  if (!timer) {
    timer = setInterval(() => void flush(), 1000);
    timer.unref();
    const pruner = setInterval(() => void prune(), 3600 * 1000);
    pruner.unref();
    void prune();
  }
  return async () => {
    if (timer) clearInterval(timer);
    timer = null;
    await flush();
  };
}

/** Request log lines from Fastify that would only repeat the request counters. */
const NOISE = new Set(['incoming request', 'request completed', 'Server listening at']);

/**
 * pino hook: copies warn and error lines (and info lines outside request
 * logging) into ops_log. Plug into Fastify's logger options as hooks.logMethod.
 */
export function pinoLogMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void, level: number): void {
  method.apply(this, args);
  try {
    const [first, second] = args;
    const msg = typeof first === 'string' ? first : typeof second === 'string' ? second : '';
    const ctx = typeof first === 'object' ? first : undefined;
    if (NOISE.has(msg) || msg.startsWith('Server listening')) return;
    const lvl: OpsLevel = level >= 60 ? 'fatal' : level >= 50 ? 'error' : level >= 40 ? 'warn' : 'info';
    if (level < 30) return;
    // request-scoped info lines (with req/res) are noise; job lines are kept
    if (lvl === 'info' && ctx && typeof ctx === 'object' && ('req' in ctx || 'res' in ctx || 'reqId' in ctx)) return;
    const c = ctx && typeof ctx === 'object' ? { ...(ctx as Record<string, unknown>) } : undefined;
    if (c) {
      delete c.req;
      delete c.res;
    }
    opsRecord(lvl, msg || (c && 'err' in c ? String((c.err as Error)?.message ?? 'error') : '(no message)'), c);
  } catch {
    /* never */
  }
}

/* ------------------------------------------------------------------ */
/* Request timing                                                       */
/* ------------------------------------------------------------------ */

interface Minute {
  minute: number;
  count: number;
  s4xx: number;
  s5xx: number;
  totalMs: number;
  maxMs: number;
  /** a sample of durations for percentiles (capped) */
  samples: number[];
}
interface RouteStat {
  count: number;
  s5xx: number;
  totalMs: number;
  maxMs: number;
}

const minutes: Minute[] = [];
const routes = new Map<string, RouteStat>();
const slow: Array<{ t: string; method: string; route: string; status: number; ms: number }> = [];
const SLOW_MS = 1000;

export function recordRequest(method: string, route: string, status: number, ms: number): void {
  const minute = Math.floor(Date.now() / 60_000);
  let m = minutes[minutes.length - 1];
  if (!m || m.minute !== minute) {
    m = { minute, count: 0, s4xx: 0, s5xx: 0, totalMs: 0, maxMs: 0, samples: [] };
    minutes.push(m);
    while (minutes.length > 60) minutes.shift();
  }
  m.count++;
  if (status >= 500) m.s5xx++;
  else if (status >= 400) m.s4xx++;
  m.totalMs += ms;
  m.maxMs = Math.max(m.maxMs, ms);
  if (m.samples.length < 500) m.samples.push(ms);

  const key = `${method} ${route}`;
  const r = routes.get(key) ?? { count: 0, s5xx: 0, totalMs: 0, maxMs: 0 };
  r.count++;
  if (status >= 500) r.s5xx++;
  r.totalMs += ms;
  r.maxMs = Math.max(r.maxMs, ms);
  routes.set(key, r);

  if (ms >= SLOW_MS) {
    slow.push({ t: new Date().toISOString(), method, route, status, ms: Math.round(ms) });
    while (slow.length > 50) slow.shift();
  }
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};

/** Totals for the last `mins` minutes. */
export function requestSummary(mins = 15) {
  const since = Math.floor(Date.now() / 60_000) - mins + 1;
  const recent = minutes.filter((m) => m.minute >= since);
  const samples = recent.flatMap((m) => m.samples);
  const count = recent.reduce((n, m) => n + m.count, 0);
  return {
    minutes: mins,
    count,
    s4xx: recent.reduce((n, m) => n + m.s4xx, 0),
    s5xx: recent.reduce((n, m) => n + m.s5xx, 0),
    avgMs: count ? Math.round(recent.reduce((n, m) => n + m.totalMs, 0) / count) : 0,
    p95Ms: pct(samples, 95),
    maxMs: Math.round(Math.max(0, ...recent.map((m) => m.maxMs))),
  };
}

export function requestReport() {
  return {
    last15: requestSummary(15),
    last60: requestSummary(60),
    perMinute: minutes.map((m) => ({
      at: new Date(m.minute * 60_000).toISOString(),
      count: m.count,
      s4xx: m.s4xx,
      s5xx: m.s5xx,
      avgMs: m.count ? Math.round(m.totalMs / m.count) : 0,
      p95Ms: pct(m.samples, 95),
    })),
    routes: [...routes.entries()]
      .map(([route, r]) => ({ route, count: r.count, s5xx: r.s5xx, avgMs: Math.round(r.totalMs / r.count), maxMs: Math.round(r.maxMs) }))
      .sort((a, b) => b.count * b.avgMs - a.count * a.avgMs)
      .slice(0, 40),
    slow: [...slow].reverse(),
  };
}

/* ------------------------------------------------------------------ */
/* Process                                                              */
/* ------------------------------------------------------------------ */

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
export const startedAt = new Date();

/** Background work reports here so diagnostics can say when each last ran. */
export const jobState: Record<string, { lastRun: string | null; lastOk: string | null; lastError: string | null; note?: string }> = {};
export function jobRan(name: string, ok: boolean, note?: string): void {
  const now = new Date().toISOString();
  const s = (jobState[name] ??= { lastRun: null, lastOk: null, lastError: null });
  s.lastRun = now;
  if (ok) s.lastOk = now;
  else s.lastError = now;
  if (note !== undefined) s.note = note;
}

export function processReport() {
  const mem = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  return {
    startedAt: startedAt.toISOString(),
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    rssMb: mb(mem.rss),
    heapUsedMb: mb(mem.heapUsed),
    heapTotalMb: mb(mem.heapTotal),
    eventLoopP99Ms: Math.round(loop.percentile(99) / 1e6),
  };
}
