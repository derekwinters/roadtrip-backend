import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireProfile } from '../auth.js'
import { listEvents } from '../events/store.js'
import { deriveNotifications } from '../notifications/derive.js'
import type { ProfileNames } from '../journal/render.js'

const querySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  wait: z.coerce.number().int().min(1).max(30).optional(),
})

/** NOTIF-001..005 per-profile notification feed. OWNER: journal/notifications feature. */
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  // NOTIF-001 — items derived from events after the cursor; NOTIF-005 — optional long-poll.
  app.get('/api/notifications', { preHandler: [requireProfile] }, async (req) => {
    const q = querySchema.parse(req.query)
    const deadline = Date.now() + (q.wait ?? 0) * 1000
    const profilesById: ProfileNames = new Map(
      (await app.pool.query('SELECT id, name, avatar FROM profiles')).rows.map((p) => [
        p.id,
        { name: p.name, avatar: p.avatar },
      ]),
    )

    let events = await listEvents(app.pool, { after: q.after })
    let items = deriveNotifications(events, req.profile!.id, profilesById)
    while (items.length === 0 && Date.now() < deadline) {
      await app.bus.waitForEvent(Math.min(deadline - Date.now(), 5000))
      events = await listEvents(app.pool, { after: q.after })
      items = deriveNotifications(events, req.profile!.id, profilesById)
    }

    // next_after advances over every scanned event (not just matching ones) so clients
    // never re-scan; with nothing scanned it echoes the request cursor.
    const nextAfter = events.length > 0 ? events[events.length - 1]!.seq : q.after
    return { items, next_after: nextAfter }
  })
}
