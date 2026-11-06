import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { AppError } from './lib/errors.js';
import { authenticate, SESSION_COOKIE } from './auth/plugin.js';
import { invalidateAuthCache } from './auth/session.js';
import { sha256 } from './lib/crypto.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { auditRoutes } from './routes/audit.js';
import { notificationRoutes } from './routes/notifications.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { orgRoutes } from './routes/org.js';
import { recruitmentRoutes } from './routes/recruitment.js';
import { employeeRoutes } from './routes/employees.js';
import { payrollRoutes } from './routes/payroll.js';
import { leaveRoutes } from './routes/leave.js';
import { platformRoutes } from './routes/platform.js';
import { integrationRoutes } from './routes/integrations.js';
import { connectRoutes } from './routes/connect.js';
import { salesRoutes } from './routes/sales.js';
import { realtimeSocketRoute, realtimeTicketRoutes } from './routes/realtime.js';
import { invalidateApiKeyCache } from './services/apiKeys.js';
import { runInCompany } from './db/client.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** runs without a company context (sign-in, company admin, switching) */
    platform?: boolean;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // only the proxies in front of the API (nginx, plus any TLS proxy) may set the client IP;
    // trusting every X-Forwarded-For would let anyone dodge the sign-in rate limit
    trustProxy: (_addr: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(cors, { origin: config.NODE_ENV === 'production' ? false : true, credentials: true });
  await app.register(multipart, { limits: { fileSize: config.UPLOAD_MAX_MB * 1024 * 1024, files: 1 } });
  // WebSocket for other systems: 256 KB per message is plenty for JSON requests and events
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  await app.register(rateLimit, {
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const token = req.cookies?.[SESSION_COOKIE];
      if (token) return `s:${sha256(token).slice(0, 32)}`;
      // each API key has its own budget
      const key = /^Bearer (hrms_[0-9a-f]{8})_/.exec(req.headers.authorization ?? '');
      return key ? `k:${key[1]}` : `ip:${req.ip}`;
    },
    max: (_req, key) => (key.startsWith('s:') ? 1200 : key.startsWith('k:') ? 600 : 300),
  });

  /*
   * Company isolation. Every signed-in route runs inside one transaction bound
   * to the session's company (db/client.ts): row-level security then limits
   * every query to that company, whatever the handler does. Routes marked
   * { config: { platform: true } } run without a company context and must use
   * rootDb or runInCompany themselves (sign-in, company admin, switching).
   */
  app.addHook('onRoute', (route) => {
    if (route.config?.platform) return;
    const handler = route.handler;
    route.handler = async function companyScoped(this: FastifyInstance, req, reply) {
      if (!req.auth) return handler.call(this, req, reply);
      // the page says which company it was loaded for; a stale tab must not act on another one
      const pageCompany = req.headers['x-company-id'];
      if (typeof pageCompany === 'string' && Number(pageCompany) !== req.auth.companyId) {
        return reply.status(409).send({ error: 'company_changed', message: 'You switched company in another tab. This page will reload' });
      }
      // Hold back any reply.send() until the transaction has committed, so a
      // client never sees "created" for a row that is not saved yet.
      // A Fastify reply is thenable (it resolves once sent); while the
      // response is held it must not be, or a handler that returns `reply`
      // would wait for a send that waits for this transaction: a deadlock.
      const r = reply as unknown as Record<string, unknown>;
      const send = reply.send.bind(reply);
      let held: { payload: unknown } | null = null;
      r.send = (payload?: unknown) => {
        held = { payload };
        return reply;
      };
      r.then = undefined;
      let result: unknown;
      try {
        result = await runInCompany(req.auth.companyId, async () => {
          const out = await handler.call(this, req, reply);
          // a returned reply (not thenable right now) means "already answered"
          return out === reply ? reply : out;
        });
      } finally {
        delete r.send;
        delete r.then;
      }
      if (held) {
        send((held as { payload: unknown }).payload);
        return reply;
      }
      return result;
    };
  });

  // Any successful write may change roles or links; drop cached sessions.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && reply.statusCode < 400) {
      invalidateAuthCache();
      invalidateApiKeyCache();
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.status(400).send({
        error: 'validation_error',
        message: first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input',
        details: err.flatten().fieldErrors,
      });
    }
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505') {
      return reply.status(409).send({ error: 'conflict', message: 'That record already exists' });
    }
    if (pgErr.code === '23503') {
      return reply.status(409).send({ error: 'conflict', message: 'That record is still referenced elsewhere' });
    }
    const fe = err as { statusCode?: unknown; code?: unknown; message?: unknown };
    if (typeof fe.statusCode === 'number' && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({
        error: typeof fe.code === 'string' ? fe.code : 'request_error',
        message: typeof fe.message === 'string' ? fe.message : 'Request error',
      });
    }
    req.log.error({ err, method: req.method, url: req.url }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Internal server error' });
  });

  app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  // real-time socket: signs in itself (API key, session or one-time ticket)
  await app.register(realtimeSocketRoute);

  await app.register(
    async (api) => {
      api.addHook('preHandler', authenticate);
      await api.register(platformRoutes, { prefix: '/platform' });
      await api.register(userRoutes, { prefix: '/users' });
      await api.register(auditRoutes, { prefix: '/audit' });
      await api.register(notificationRoutes, { prefix: '/notifications' });
      await api.register(dashboardRoutes, { prefix: '/dashboard' });
      await api.register(orgRoutes, { prefix: '/org' });
      await api.register(recruitmentRoutes, { prefix: '/recruitment' });
      await api.register(employeeRoutes, { prefix: '/employees' });
      await api.register(payrollRoutes, { prefix: '/payroll' });
      await api.register(leaveRoutes, { prefix: '/leave' });
      await api.register(integrationRoutes, { prefix: '/integrations' });
      await api.register(connectRoutes, { prefix: '/connect' });
      await api.register(salesRoutes, { prefix: '/sales' });
      await api.register(realtimeTicketRoutes, { prefix: '/realtime' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
