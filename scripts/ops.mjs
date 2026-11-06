#!/usr/bin/env node
/**
 * Remote diagnostics for a running HRMS, from any computer: no SSH, no login.
 * Reads OPS_URL and OPS_TOKEN from .ops.local (git ignores it) or the environment.
 *
 *   node scripts/ops.mjs init --url https://hr.example.com   new token in .ops.local
 *   node scripts/ops.mjs status                               health and problems
 *   node scripts/ops.mjs errors [--since 24h] [--list]        warnings and errors
 *   node scripts/ops.mjs logs [--since 1h] [--grep text] [--level warn] [--follow]
 *   node scripts/ops.mjs requests                             API timing, slow requests
 *   node scripts/ops.mjs db                                   connections, queries, tables
 *
 * Add --json to any command for the raw answer.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const localFile = join(root, '.ops.local');
const [cmd = 'status', ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) continue;
  const k = rest[i].slice(2);
  flags[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
}

function settings() {
  const env = { OPS_URL: process.env.OPS_URL, OPS_TOKEN: process.env.OPS_TOKEN };
  if (existsSync(localFile)) {
    for (const line of readFileSync(localFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(OPS_URL|OPS_TOKEN)\s*=\s*(.+?)\s*$/.exec(line);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  }
  if (!env.OPS_URL || !env.OPS_TOKEN) {
    console.error('No OPS_URL / OPS_TOKEN. Run: node scripts/ops.mjs init --url https://your-hrms');
    process.exit(2);
  }
  return env;
}

async function get(path, query = {}) {
  const { OPS_URL, OPS_TOKEN } = settings();
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== false).map(([k, v]) => [k, String(v)]));
  const url = `${OPS_URL.replace(/\/$/, '')}/api/v1/ops${path}${qs.size ? `?${qs}` : ''}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'x-ops-token': OPS_TOKEN }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    console.error(`Could not reach ${OPS_URL}: ${err.message}`);
    process.exit(1);
  }
  if (res.status === 404) {
    console.error('Diagnostics are off on that server: set OPS_TOKEN there (same value as .ops.local) and redeploy.');
    process.exit(1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${res.status}: ${body.message ?? 'request failed'}`);
    process.exit(1);
  }
  return body;
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const time = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 19);
const ctxText = (ctx) => {
  if (!ctx) return '';
  const { err, ...other } = ctx;
  const parts = [];
  if (Object.keys(other).length) parts.push(JSON.stringify(other));
  if (err) parts.push(`${err.type ?? 'Error'}: ${err.message ?? ''}${err.stack ? `\n${err.stack.split('\n').slice(1, 5).join('\n')}` : ''}`);
  return parts.join('\n');
};
const out = (data, render) => (flags.json ? console.log(JSON.stringify(data, null, 2)) : render(data));

const commands = {
  init() {
    const url = flags.url;
    if (!url || url === true) {
      console.error('Usage: node scripts/ops.mjs init --url https://your-hrms');
      process.exit(2);
    }
    if (existsSync(localFile) && !flags.force) {
      console.error('.ops.local exists. Add --force to replace its token.');
      process.exit(2);
    }
    const token = randomBytes(32).toString('hex');
    writeFileSync(localFile, `OPS_URL=${url}\nOPS_TOKEN=${token}\n`, { mode: 0o600 });
    console.log(`Wrote .ops.local. Set this on the server (Coolify: Environment Variables) and redeploy:\n\nOPS_TOKEN=${token}\n`);
  },

  async status() {
    out(await get('/status'), (s) => {
      console.log(`${s.problems.length ? red('Problems') : green('No problems')}  ${dim(s.at)}`);
      for (const p of s.problems) console.log(`  - ${p}`);
      const p = s.process;
      console.log(`\nAPI      up ${Math.round(p.uptimeSec / 60)}m since ${time(p.startedAt)}, ${p.rssMb} MB, loop p99 ${p.eventLoopP99Ms} ms, node ${p.node}${s.build.commit ? `, commit ${s.build.commit.slice(0, 7)}` : ''}`);
      console.log(`Database ${s.db.ms} ms, ${s.db.size}, postgres ${s.db.version}, ${s.db.connections} connections, pool ${s.db.pool.total - s.db.pool.idle}/${s.db.pool.max} busy, ${s.db.pool.waiting} waiting, ${s.db.migrations.applied} migrations`);
      const r = s.requests;
      console.log(`Requests ${r.count} in 15m, ${r.s5xx} 5xx, ${r.s4xx} 4xx, avg ${r.avgMs} ms, p95 ${r.p95Ms} ms, max ${r.maxMs} ms`);
      console.log(`Logs     24h: ${s.logs.errors24h} errors, ${s.logs.warns24h} warnings, ${s.logs.boots24h} starts`);
      const w = s.webhooks;
      console.log(`Webhooks ${w.pending} pending (${w.due} due${w.oldestPendingMin ? `, oldest ${w.oldestPendingMin}m` : ''}), 24h: ${w.delivered24h} delivered, ${w.failed24h} gave up`);
      const i = s.integrations;
      console.log(`Connect  ${i.keys} API keys (${i.keysUsed24h} used 24h), ${i.links} linked accounts, 24h: ${i.events24h} events, ${i.sales24h} sales, ${i.metrics24h} figures`);
      for (const [name, j] of Object.entries(s.jobs)) console.log(`Job      ${name}: last ok ${ago(j.lastOk)}${j.lastError ? red(`, last error ${ago(j.lastError)}`) : ''}${j.note ? dim(` (${j.note})`) : ''}`);
      console.log('\nCompanies');
      for (const c of s.companies) console.log(`  ${c.slug.padEnd(16)} ${c.status.padEnd(9)} ${String(c.active).padStart(5)} active / ${c.employees} staff, ${c.users} users, ${c.signedIn24h} signed in 24h`);
      if (s.boots.length) console.log(`\nStarts   ${s.boots.map((b) => ago(b.t)).join(', ')}`);
    });
  },

  async errors() {
    const data = await get('/errors', { since: flags.since, list: flags.list ? 1 : undefined });
    out(data, (d) => {
      if (d.errors) {
        if (!d.errors.length) return console.log(green('No warnings or errors'));
        for (const e of d.errors.reverse()) console.log(`${dim(time(e.t))} ${e.lvl === 'warn' ? 'WARN ' : red('ERROR')} ${e.msg}${e.ctx ? `\n${dim(ctxText(e.ctx))}` : ''}`);
        return;
      }
      if (!d.groups.length) return console.log(green(`No warnings or errors in ${flags.since ?? '24h'}`));
      for (const g of d.groups) {
        console.log(`${g.lvl === 'warn' ? 'WARN ' : red('ERROR')} ×${g.count}  ${g.msg}  ${dim(`last ${ago(g.last)}, first ${ago(g.first)}`)}`);
        if (g.latestCtx) console.log(dim(ctxText(g.latestCtx).replace(/^/gm, '    ')));
      }
    });
  },

  async logs() {
    const show = (rows) => {
      for (const e of rows) {
        const lvl = e.lvl === 'error' || e.lvl === 'fatal' ? red(e.lvl.toUpperCase().padEnd(5)) : e.lvl.toUpperCase().padEnd(5);
        console.log(`${dim(time(e.t))} ${lvl} ${e.msg}${e.ctx && flags.verbose ? `\n${dim(ctxText(e.ctx))}` : e.ctx ? dim(` ${JSON.stringify(e.ctx).slice(0, 160)}`) : ''}`);
      }
    };
    const data = await get('/logs', { since: flags.since, grep: flags.grep, level: flags.level, limit: flags.limit });
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    show([...data.logs].reverse());
    if (!flags.follow) return;
    let last = data.logs[0]?.t ?? new Date().toISOString();
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const more = (await get('/logs', { since: '10m', grep: flags.grep, level: flags.level })).logs.filter((e) => e.t > last);
      if (more.length) {
        show([...more].reverse());
        last = more[0].t;
      }
    }
  },

  async requests() {
    out(await get('/requests'), (r) => {
      const s = (x) => `${x.count} requests, ${x.s5xx} 5xx, ${x.s4xx} 4xx, avg ${x.avgMs} ms, p95 ${x.p95Ms} ms, max ${x.maxMs} ms`;
      console.log(`Last 15m  ${s(r.last15)}\nLast 60m  ${s(r.last60)}\n`);
      console.log('Busiest routes (since the API started)');
      for (const x of r.routes.slice(0, 20)) console.log(`  ${String(x.count).padStart(6)} × ${String(x.avgMs).padStart(5)} ms avg ${String(x.maxMs).padStart(6)} max ${x.s5xx ? red(`${x.s5xx} 5xx `) : ''}${x.route}`);
      if (r.slow.length) {
        console.log('\nSlow requests (≥ 1 s)');
        for (const x of r.slow.slice(0, 20)) console.log(`  ${dim(time(x.t))} ${String(x.ms).padStart(6)} ms ${x.status} ${x.method} ${x.route}`);
      }
    });
  },

  async db() {
    out(await get('/db'), (d) => {
      console.log('Connections');
      for (const c of d.connections) console.log(`  ${String(c.count).padStart(3)} ${c.state.padEnd(22)} ${c.user ?? ''} ${c.oldestSec ? dim(`oldest ${c.oldestSec}s`) : ''}`);
      if (d.running.length) {
        console.log('\nRunning');
        for (const q of d.running) console.log(`  ${String(q.sec).padStart(5)}s ${q.state} ${q.wait ?? ''} ${dim(q.query.replace(/\s+/g, ' '))}`);
      }
      console.log('\nTables');
      for (const t of d.tables) console.log(`  ${t.table.padEnd(24)} ${String(t.rows).padStart(9)} rows ${t.size.padStart(9)}`);
    });
  },
};

if (!commands[cmd]) {
  console.error(`Unknown command ${cmd}. Commands: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
await commands[cmd]();
