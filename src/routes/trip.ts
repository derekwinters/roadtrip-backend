import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireProfile } from '../auth.js'
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
}
