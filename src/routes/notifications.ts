import type { FastifyInstance } from 'fastify'
import { requireProfile } from '../auth.js'

/** NOTIF-001..005 per-profile notification feed. OWNER: journal/notifications feature. */
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/notifications', { preHandler: [requireProfile] }, async () => ({ items: [], next_after: 0 }))
}
