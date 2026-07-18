import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireProfile } from '../auth.js'
import { CLIENT_EVENT_TYPES, validateEventPayload } from '../events/schemas.js'
import { appendEvent } from '../events/store.js'
import { processNewPings } from '../location/engine.js'

const batchSchema = z
  .object({
    device_id: z.string().max(100).optional(),
    events: z
      .array(
        z.object({
          event_id: z.string().uuid(),
          type: z.string(),
          client_ts: z.string().datetime({ offset: true }),
          payload: z.unknown(),
        }),
      )
      .max(500),
  })
  .strict()

interface BatchResult {
  event_id: string
  status: 'accepted' | 'duplicate' | 'rejected'
  reason?: string
  seq?: number
}

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  // SYNC-001..005, EVT-001/004/005.
  app.post('/api/sync/batch', { preHandler: [requireProfile] }, async (req) => {
    const body = batchSchema.parse(req.body)
    const results: BatchResult[] = []
    const acceptedPingSeqs: number[] = []

    for (const ev of body.events) {
      // EVT-004 — clients may only upload the whitelisted types.
      if (!CLIENT_EVENT_TYPES.has(ev.type)) {
        results.push({ event_id: ev.event_id, status: 'rejected', reason: 'forbidden_type' })
        continue
      }
      // EVT-005 — pings only from parents.
      if (ev.type === 'location.ping' && req.profile!.role !== 'parent') {
        results.push({ event_id: ev.event_id, status: 'rejected', reason: 'not_parent' })
        continue
      }
      // SYNC-004 — per-event payload validation.
      const valid = validateEventPayload(ev.type, ev.payload)
      if (!valid.ok) {
        results.push({ event_id: ev.event_id, status: 'rejected', reason: valid.error })
        continue
      }
      const res = await appendEvent(app.pool, {
        eventId: ev.event_id,
        type: ev.type,
        actorId: req.profile!.id,
        deviceId: body.device_id ?? null,
        payload: valid.payload,
        clientTs: ev.client_ts,
      })
      results.push({ event_id: ev.event_id, status: res.status === 'inserted' ? 'accepted' : 'duplicate', seq: res.seq })
      if (res.status === 'inserted' && ev.type === 'location.ping') acceptedPingSeqs.push(res.seq)
    }

    // SYNC-005 — the location engine sees flushed pings in client_ts order.
    if (acceptedPingSeqs.length > 0) {
      await processNewPings(app.pool, app.bus, acceptedPingSeqs)
    }
    app.bus.notify()
    return { results }
  })
}
