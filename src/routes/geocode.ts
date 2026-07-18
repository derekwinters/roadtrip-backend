import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireParent } from '../auth.js'
import type { GeocodeSearch } from '../geocode/search.js'

const querySchema = z.object({ q: z.string().trim().min(1).max(200) })

/**
 * GET /api/geocode — parent-only address search proxy (GSR-001). Cache-first, then
 * throttled upstream; 503 geocode_unavailable when offline without a cached result
 * (GSR-002..005). Best-effort online by design — see docs/spec/13-geocode-search.md.
 */
export function geocodeRoutes(search: GeocodeSearch) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.get('/api/geocode', { preHandler: [requireParent] }, async (req) => {
      const { q } = querySchema.parse(req.query)
      return search.search(q)
    })
  }
}
