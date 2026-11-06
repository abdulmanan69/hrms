/**
 * Real-time connection for other systems and browser apps: GET /api/v1/ws.
 *
 * Sign-in at connect (one of):
 *   - Authorization: Bearer hrms_… (servers, API key)
 *   - the session cookie (same-site browser pages)
 *   - ?ticket=… from POST /api/v1/realtime/ticket (browser apps on other sites;
 *     the ticket works once, for 30 seconds, so no key ends up in a URL log)
 *
 * Messages are JSON. From the client:
 *   { "type": "subscribe", "events": ["employee.*", "leave_application.approved"], "since": 1234 }
 *   { "type": "request", "id": "1", "method": "GET", "path": "/employees?status=active" }
 *   { "type": "ping" }
 * From the server:
 *   { "type": "welcome", "company": …, "permissions": […], "lastEventId": … }
 *   { "type": "event", "id": 1240, "event": "leave_application.approved", "occurredAt": "…", "data": {…} }
 *   { "type": "response", "id": "1", "status": 200, "body": {…} }
 *   { "type": "error", "message": "…" }
 *
 * A request over the socket runs through the normal HTTP pipeline (app.inject)
 * with the connection's own credentials: same permissions, same company,
 * same rate limit, same audit trail.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { asc, desc, gt } from 'drizzle-orm';
import { z } from 'zod';
import { rootDb } from '../db/client.js';
import { events } from '../db/schema.js';
import { SESSION_COOKIE } from '../auth/plugin.js';
import { hasPermission, type Permission } from '../auth/permissions.js';
import { resolveSession, type AuthContext } from '../auth/session.js';
import { resolveApiKey } from '../services/apiKeys.js';
import { matches } from '../services/events.js';
import { randomName } from '../lib/crypto.js';
import { UnauthorizedError } from '../lib/errors.js';

const MAX_SOCKETS = 1000;
const MAX_PER_CREDENTIAL = 20;
const TICKET_MS = 30_000;
const REAUTH_MS = 60_000;
const HEARTBEAT_MS = 30_000;

type Credential = { kind: 'session'; token: string } | { kind: 'key'; token: string };

interface Client {
  ws: WebSocket;
  auth: AuthContext;
  cred: Credential;
  patterns: string[];
  alive: boolean;
  checkedAt: number;
}

const clients = new Set<Client>();
const tickets = new Map<string, { cred: Credential; expires: number }>();

async function resolve(cred: Credential): Promise<AuthContext | null> {
  return cred.kind === 'key' ? resolveApiKey(cred.token) : resolveSession(cred.token);
}

function send(c: Client, msg: unknown): void {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
}

function canSee(auth: AuthContext, module: string): boolean {
  return hasPermission(auth.permissions, module as Permission);
}

/* ------------------------------------------------------------------ */
/* Event fan-out: one poller per process, only while someone listens    */
/* ------------------------------------------------------------------ */

let lastEventId = 0;
let poller: NodeJS.Timeout | null = null;
let polling = false;

async function poll(): Promise<void> {
  if (polling || clients.size === 0) return;
  polling = true;
  try {
    const rows = await rootDb.select().from(events).where(gt(events.id, lastEventId)).orderBy(asc(events.id)).limit(500);
    for (const e of rows) {
      lastEventId = e.id;
      const msg = { type: 'event', id: e.id, event: e.type, occurredAt: e.occurredAt.toISOString(), data: e.data };
      for (const c of clients) {
        if (c.auth.companyId !== e.companyId) continue;
        if (!canSee(c.auth, e.module)) continue;
        if (!c.patterns.some((p) => matches(p, e.type))) continue;
        send(c, msg);
      }
    }
  } catch {
    // transient database trouble: the next tick retries from the same id
  } finally {
    polling = false;
  }
}

async function ensurePoller(): Promise<void> {
  if (poller) return;
  const [last] = await rootDb.select({ id: events.id }).from(events).orderBy(desc(events.id)).limit(1);
  lastEventId = last?.id ?? 0;
  poller = setInterval(() => void poll(), 1000);
}

function stopPollerIfIdle(): void {
  if (clients.size === 0 && poller) {
    clearInterval(poller);
    poller = null;
  }
}

/* ------------------------------------------------------------------ */
/* Messages from a client                                                */
/* ------------------------------------------------------------------ */

const message = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('subscribe'),
    events: z.array(z.string().regex(/^(\*|[a-z_]+\.(\*|[a-z_]+))$/, 'Use "*", "entity.*" or "entity.action"')).min(1).max(50),
    /** replay events after this id first (missed while disconnected) */
    since: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('request'),
    id: z.union([z.string().max(64), z.number()]),
    method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
    path: z
      .string()
      .max(2000)
      .regex(/^\/[^\s]*$/, 'path must start with /')
      .refine((p) => !p.includes('..') && !/^\/(ws|realtime)/.test(p), 'This path is not available over the socket'),
    body: z.unknown().optional(),
  }),
]);

async function onMessage(app: FastifyInstance, c: Client, raw: string): Promise<void> {
  let parsed: z.infer<typeof message>;
  try {
    parsed = message.parse(JSON.parse(raw));
  } catch (err) {
    send(c, { type: 'error', message: err instanceof z.ZodError ? err.issues[0]?.message ?? 'Invalid message' : 'Messages must be JSON' });
    return;
  }

  if (parsed.type === 'ping') return send(c, { type: 'pong', at: new Date().toISOString() });

  if (parsed.type === 'subscribe') {
    c.patterns = parsed.events;
    send(c, { type: 'subscribed', events: c.patterns });
    if (parsed.since !== undefined) {
      // replay from the outbox, with the same company, permission and pattern filters
      const rows = await rootDb.select().from(events).where(gt(events.id, parsed.since)).orderBy(asc(events.id)).limit(500);
      for (const e of rows) {
        if (e.companyId !== c.auth.companyId || !canSee(c.auth, e.module) || !c.patterns.some((p) => matches(p, e.type))) continue;
        send(c, { type: 'event', id: e.id, event: e.type, occurredAt: e.occurredAt.toISOString(), data: e.data, replay: true });
      }
    }
    return;
  }

  // a request: replayed through the HTTP pipeline with this connection's credentials
  const headers: Record<string, string> =
    c.cred.kind === 'key' ? { authorization: `Bearer ${c.cred.token}` } : { cookie: `${SESSION_COOKIE}=${c.cred.token}` };
  const res = await app.inject({
    method: parsed.method,
    url: `/api/v1${parsed.path}`,
    headers: { ...headers, ...(parsed.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: parsed.body !== undefined ? JSON.stringify(parsed.body) : undefined,
  });
  const type = String(res.headers['content-type'] ?? '');
  if (!type.includes('application/json')) {
    send(c, { type: 'response', id: parsed.id, status: res.statusCode, error: 'This endpoint returns a file. Download it over HTTP with the same key' });
    return;
  }
  send(c, { type: 'response', id: parsed.id, status: res.statusCode, body: res.json() });
}

/* ------------------------------------------------------------------ */
/* Routes                                                               */
/* ------------------------------------------------------------------ */

/** Inside the signed-in API: a one-time ticket for a browser WebSocket on another site. */
export async function realtimeTicketRoutes(app: FastifyInstance): Promise<void> {
  app.post('/ticket', { config: { platform: true } }, async (req) => {
    const cookie = req.cookies?.[SESSION_COOKIE];
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const cred: Credential | null = bearer?.startsWith('hrms_') ? { kind: 'key', token: bearer } : cookie ? { kind: 'session', token: cookie } : null;
    if (!cred) throw new UnauthorizedError();
    const now = Date.now();
    for (const [k, t] of tickets) if (t.expires < now) tickets.delete(k);
    if (tickets.size > 10_000) throw new UnauthorizedError('Too many open tickets, try again shortly');
    const ticket = randomName(24);
    tickets.set(ticket, { cred, expires: now + TICKET_MS });
    return { ticket, expiresInSeconds: TICKET_MS / 1000, url: '/api/v1/ws?ticket=' + ticket };
  });
}

function credentialOf(req: FastifyRequest): Credential | null {
  const q = req.query as { ticket?: string };
  if (q?.ticket) {
    const t = tickets.get(q.ticket);
    tickets.delete(q.ticket); // one use
    return t && t.expires > Date.now() ? t.cred : null;
  }
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  if (bearer?.startsWith('hrms_')) return { kind: 'key', token: bearer };
  const cookie = req.cookies?.[SESSION_COOKIE];
  return cookie ? { kind: 'session', token: cookie } : null;
}

export async function realtimeSocketRoute(app: FastifyInstance): Promise<void> {
  // heartbeat: drop connections that stopped answering pings
  const beat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, HEARTBEAT_MS);
  app.addHook('onClose', async () => {
    clearInterval(beat);
    if (poller) clearInterval(poller);
    for (const c of clients) c.ws.close(1001, 'Server shutting down');
  });

  app.get('/api/v1/ws', { websocket: true, config: { platform: true } }, async (socket, req) => {
    // Listen before anything is awaited: a client may send its first message the
    // moment the socket opens. Messages queue up and run one at a time, in order.
    const queue: string[] = [];
    let client: Client | null = null;
    let draining = false;
    let closed = false;
    const drain = async () => {
      if (draining || !client) return;
      draining = true;
      try {
        while (queue.length && !closed) {
          const c = client;
          // access may have changed (key revoked, role edited, signed out): re-check every minute
          if (Date.now() - c.checkedAt > REAUTH_MS) {
            const fresh = await resolve(c.cred);
            if (!fresh) {
              socket.close(4401, 'Access ended');
              return;
            }
            c.auth = fresh;
            c.checkedAt = Date.now();
          }
          const raw = queue.shift()!;
          try {
            await onMessage(app, c, raw);
          } catch {
            send(c, { type: 'error', message: 'Could not process the message' });
          }
        }
      } finally {
        draining = false;
      }
    };
    socket.on('message', (raw) => {
      if (queue.length >= 100) {
        socket.close(4429, 'Too many messages waiting; wait for responses before sending more');
        return;
      }
      queue.push(raw.toString());
      void drain();
    });
    socket.on('close', () => {
      closed = true;
      if (client) clients.delete(client);
      stopPollerIfIdle();
    });

    const cred = credentialOf(req);
    const auth = cred ? await resolve(cred) : null;
    if (closed) return;
    if (!cred || !auth) {
      socket.close(4401, 'Sign in with an API key, a session or a ticket');
      return;
    }
    if (clients.size >= MAX_SOCKETS) {
      socket.close(4429, 'Too many connections');
      return;
    }
    const same = [...clients].filter((c) => c.cred.token === cred.token).length;
    if (same >= MAX_PER_CREDENTIAL) {
      socket.close(4429, `At most ${MAX_PER_CREDENTIAL} connections per key or session`);
      return;
    }

    const c: Client = { ws: socket, auth, cred, patterns: ['*'], alive: true, checkedAt: Date.now() };
    socket.on('pong', () => {
      c.alive = true;
    });
    clients.add(c);
    await ensurePoller();
    if (closed) {
      clients.delete(c);
      stopPollerIfIdle();
      return;
    }
    send(c, {
      type: 'welcome',
      company: { id: auth.companyId, name: auth.companyName },
      as: auth.apiKeyName ? { apiKey: auth.apiKeyName } : { user: auth.name },
      permissions: auth.permissions,
      lastEventId,
      subscribed: c.patterns,
    });
    // from here on, queued and new messages are handled
    client = c;
    void drain();
  });

  // idle sockets too: re-check access every minute, close those that lost it
  const recheck = setInterval(async () => {
    for (const c of clients) {
      if (Date.now() - c.checkedAt < REAUTH_MS) continue;
      const fresh = await resolve(c.cred).catch(() => null);
      if (!fresh) c.ws.close(4401, 'Access ended');
      else {
        c.auth = fresh;
        c.checkedAt = Date.now();
      }
    }
  }, REAUTH_MS);
  app.addHook('onClose', async () => clearInterval(recheck));
}

/** Connected sockets right now (for the Integrations page). */
export function realtimeStats(companyId: number): { connections: number } {
  return { connections: [...clients].filter((c) => c.auth.companyId === companyId).length };
}
