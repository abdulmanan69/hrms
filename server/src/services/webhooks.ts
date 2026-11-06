/**
 * Webhook delivery. Runs in the API process as a small background loop.
 *
 * - Claims due deliveries with a lease (UPDATE … FOR UPDATE SKIP LOCKED), so
 *   several API instances never send the same delivery twice at once.
 * - Sends outside any database transaction: a slow receiver never holds a
 *   connection. At most 4 requests in flight, 10 s timeout each.
 * - Retries with backoff: 30 s, 1 min, 2 min … up to 8 attempts (about a day).
 * - Signs every request: X-HRMS-Signature = sha256=HMAC(secret, "<timestamp>.<body>").
 * - Refuses URLs that resolve to private, loopback or link-local addresses
 *   (the database, cloud metadata …) unless WEBHOOK_ALLOW_PRIVATE=true.
 *   Redirects are not followed.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { rootDb } from '../db/client.js';
import { events, webhookDeliveries, webhooks } from '../db/schema.js';
import { ValidationError } from '../lib/errors.js';

const MAX_ATTEMPTS = 8;
const BATCH = 20;
const PARALLEL = 4;
const TIMEOUT_MS = 10_000;

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

export function sign(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? privateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** Throws a readable ValidationError when a URL may not receive webhooks. */
export async function assertWebhookUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('Enter a full URL, e.g. https://example.com/hooks/hrms');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ValidationError('Use an https:// URL');
  if (url.username || url.password) throw new ValidationError('Put credentials in the receiver, not in the URL');
  if (config.WEBHOOK_ALLOW_PRIVATE) return url;
  if (url.protocol !== 'https:') throw new ValidationError('Use an https:// URL (plain http is only allowed when WEBHOOK_ALLOW_PRIVATE=true)');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) throw new ValidationError(`${url.hostname} could not be found`);
  if (addrs.some(privateAddress)) {
    throw new ValidationError(`${url.hostname} is a private address. Set WEBHOOK_ALLOW_PRIVATE=true to send to internal systems`);
  }
  return url;
}

type Claimed = typeof webhookDeliveries.$inferSelect;

/** Sends one delivery and returns how it went. Never throws. */
export async function sendOnce(
  hook: { url: string; secret: string },
  d: { id: number; eventType: string; payload: unknown },
): Promise<{ ok: boolean; status: number | null; error: string | null; ms: number }> {
  const started = Date.now();
  const body = JSON.stringify(d.payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  try {
    await assertWebhookUrl(hook.url); // re-checked at send time: DNS may have changed
    const res = await fetch(hook.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'WaveTech-HRMS-Webhooks/1',
        'x-hrms-event': d.eventType,
        'x-hrms-delivery': String(d.id),
        'x-hrms-timestamp': timestamp,
        'x-hrms-signature': sign(hook.secret, timestamp, body),
      },
      body,
    });
    await res.body?.cancel().catch(() => undefined);
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, error: ok ? null : `Receiver answered ${res.status}`, ms: Date.now() - started };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'TimeoutError' ? `No answer within ${TIMEOUT_MS / 1000} s` : err.message) : 'Request failed';
    return { ok: false, status: null, error: msg.slice(0, 300), ms: Date.now() - started };
  }
}

async function claimDue(): Promise<Claimed[]> {
  const res = await rootDb.execute<Record<string, unknown>>(sql`
    update webhook_deliveries d
       set next_attempt_at = now() + interval '2 minutes', attempts = d.attempts + 1
     where d.id in (
       select id from webhook_deliveries
        where status = 'pending' and next_attempt_at <= now()
        order by id
        limit ${BATCH}
        for update skip locked)
    returning d.id, d.webhook_id, d.event_type, d.payload, d.attempts`);
  return res.rows.map((r) => ({
    id: r.id as number,
    webhookId: r.webhook_id as number,
    eventType: r.event_type as string,
    payload: r.payload,
    attempts: r.attempts as number,
  })) as unknown as Claimed[];
}

async function deliver(d: Claimed): Promise<void> {
  const [hook] = await rootDb.select().from(webhooks).where(eq(webhooks.id, d.webhookId));
  if (!hook || !hook.active) {
    await rootDb.update(webhookDeliveries).set({ status: 'failed', error: 'Webhook is switched off' }).where(eq(webhookDeliveries.id, d.id));
    return;
  }
  const r = await sendOnce(hook, d);
  if (r.ok) {
    await rootDb
      .update(webhookDeliveries)
      .set({ status: 'delivered', responseStatus: r.status, error: null, durationMs: r.ms, deliveredAt: new Date() })
      .where(eq(webhookDeliveries.id, d.id));
    return;
  }
  const last = d.attempts >= MAX_ATTEMPTS;
  const backoffSec = Math.min(30 * 2 ** (d.attempts - 1), 6 * 3600);
  await rootDb
    .update(webhookDeliveries)
    .set({
      status: last ? 'failed' : 'pending',
      responseStatus: r.status,
      error: r.error,
      durationMs: r.ms,
      nextAttemptAt: new Date(Date.now() + backoffSec * 1000),
    })
    .where(eq(webhookDeliveries.id, d.id));
}

/** Old events and finished deliveries are kept 30 days. */
async function prune(): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  await rootDb
    .delete(webhookDeliveries)
    .where(and(inArray(webhookDeliveries.status, ['delivered', 'failed']), lt(webhookDeliveries.createdAt, cutoff)));
  await rootDb.delete(events).where(lt(events.occurredAt, cutoff));
}

/** Starts the delivery loop; returns a stop function. */
export function startWebhookWorker(log: { error: (o: object, m: string) => void }): () => void {
  let running = false;
  let stopped = false;
  let lastPrune = 0;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (;;) {
        const due = await claimDue();
        if (due.length === 0) break;
        for (let i = 0; i < due.length; i += PARALLEL) {
          await Promise.all(due.slice(i, i + PARALLEL).map((d) => deliver(d).catch((err) => log.error({ err, id: d.id }, 'webhook delivery failed'))));
        }
        if (due.length < BATCH || stopped) break;
      }
      if (Date.now() - lastPrune > 3600_000) {
        lastPrune = Date.now();
        await prune();
      }
    } catch (err) {
      log.error({ err }, 'webhook worker tick failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 2000);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
