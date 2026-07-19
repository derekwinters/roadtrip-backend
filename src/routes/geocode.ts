import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireParent } from '../auth.js'
import type { GeocodeSearch } from '../geocode/search.js'

const querySchema = z.object({ q: z.string().trim().min(1).max(200) })

/**
 * GET /api/geocode — parent-only address search proxy (GSR-001). Cache-first, then
 * throttled upstream. On a cache miss whose upstream call fails, the search service throws
 * an AppError that the global error handler renders as the standard envelope, surfacing the
 * distinct 503 reason: `geocode_unavailable` when the upstream is unreachable/offline
 * (GSR-004) vs. `geocode_upstream_error` (carrying the upstream HTTP status) when the
 * upstream is reached but refuses (GSR-006). Best-effort online by design — see
 * docs/spec/13-geocode-search.md.
 */
export function geocodeRoutes(search: GeocodeSearch) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.get('/api/geocode', { preHandler: [requireParent] }, async (req) => {
      const { q } = querySchema.parse(req.query)
      return search.search(q)
    })
  }
}
