import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req) => {
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, req.auth.userId))
      .orderBy(desc(notifications.id))
      .limit(30);
    const [{ unread }] = await db
      .select({ unread: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, req.auth.userId), isNull(notifications.readAt)));
    return { data: rows, unread };
  });

  app.post('/read', async (req) => {
    const body = z.object({ id: z.number().int().optional() }).parse(req.body ?? {});
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, req.auth.userId),
          isNull(notifications.readAt),
          body.id ? eq(notifications.id, body.id) : undefined,
        ),
      );
    return { ok: true };
  });
}
