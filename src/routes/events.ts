import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireProfile } from '../auth.js'
import { listEvents } from '../events/store.js'
import { redactOngoingHangmanWords } from '../games/service.js'

const querySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(500).default(200),
  types: z.string().optional(),
  wait: z.coerce.number().int().min(1).max(30).optional(),
})

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  // EVT-007 (cursor feed) + EVT-008 (long-poll).
  app.get('/api/events', { preHandler: [requireProfile] }, async (req) => {
    const q = querySchema.parse(req.query)
    const types = q.types ? q.types.split(',').map((t) => t.trim()).filter(Boolean) : undefined
    const deadline = Date.now() + (q.wait ?? 0) * 1000

    let events = await listEvents(app.pool, { after: q.after, limit: q.limit, types })
    while (events.length === 0 && Date.now() < deadline) {
      await app.bus.waitForEvent(Math.min(deadline - Date.now(), 5000))
      events = await listEvents(app.pool, { after: q.after, limit: q.limit, types })
    }

    const nextAfter = events.length > 0 ? events[events.length - 1]!.seq : q.after
    // Hangman words never leak through the family-visible feed while a game runs (GAME-014).
    return { events: await redactOngoingHangmanWords(app.pool, events), next_after: nextAfter }
  })
}
