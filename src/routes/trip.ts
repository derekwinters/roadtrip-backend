import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireParent, requireProfile } from '../auth.js'
import { endActiveLeg } from '../location/engine.js'
import { resolveTripScope } from '../trips/scope.js'
import { computeTripSummary } from '../trips/summary.js'

const querySchema = z.object({ trip: z.string().uuid().optional() })

/**
 * SUM-002: aggregation for the trip in scope. The scope is ?trip=<id>, else the active
 * trip, else the most recently ended one (TRIP-007); with no trips at all it aggregates
 * the whole event stream exactly as before trips existed. Totals partition exactly into
 * the completed legs plus the in-progress leg (SUM-003), because leg summaries use the
 * same overlap accounting.
 */
export async function tripRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/trip/summary', { preHandler: [requireProfile] }, async (req) => {
    const q = querySchema.parse(req.query)
    const scope = await resolveTripScope(app.pool, q.trip)
    return computeTripSummary(app.pool, scope)
  })

  // LOC-013 — manually end the current leg: mark the active destination arrived now,
  // record its leg, and do NOT advance (parent-only; 409 when no destination is active).
  app.post('/api/trip/leg/end', { preHandler: [requireParent] }, async (req) => {
    return endActiveLeg(app.pool, app.bus, req.profile!.id)
  })
}
