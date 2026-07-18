import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireProfile } from '../auth.js'
import { decimate, haversineMiles } from '../location/geo.js'
import { resolveTripScope } from '../trips/scope.js'

const querySchema = z.object({
  max_points: z.coerce.number().int().min(2).max(10_000).default(500),
  trip: z.string().uuid().optional(),
})

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : v)

/**
 * LOC-008: latest position, trip start, breadcrumb, active destination, leg progress —
 * scoped to the trip in scope (TRIP-007; unscoped when no trips exist).
 */
export async function mapRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/map', { preHandler: [requireProfile] }, async (req) => {
    const q = querySchema.parse(req.query)
    const scope = await resolveTripScope(app.pool, q.trip)

    const { rows: pings } = await app.pool.query(
      scope !== null
        ? `SELECT p.lat, p.lon, p.client_ts FROM pings p JOIN events e ON e.seq = p.seq
           WHERE e.trip_id = $1 ORDER BY p.client_ts, p.seq`
        : 'SELECT lat, lon, client_ts FROM pings ORDER BY client_ts, seq',
      scope !== null ? [scope] : [],
    )
    const breadcrumb = decimate(
      pings.map((p: any) => ({ lat: Number(p.lat), lon: Number(p.lon), ts: iso(p.client_ts) })),
      q.max_points,
    )

    const first = breadcrumb[0] ?? null
    const latest = pings.length > 0 ? pings[pings.length - 1] : null
    const current = latest
      ? { lat: Number(latest.lat), lon: Number(latest.lon), ts: iso(latest.client_ts) }
      : null

    const { rows: dests } = await app.pool.query(
      scope !== null
        ? `SELECT id, name, lat, lon, order_index, status, arrived_at FROM destinations
           WHERE status = 'active' AND trip_id = $1 ORDER BY order_index, created_at LIMIT 1`
        : `SELECT id, name, lat, lon, order_index, status, arrived_at FROM destinations
           WHERE status = 'active' ORDER BY order_index, created_at LIMIT 1`,
      scope !== null ? [scope] : [],
    )
    const active = dests[0] ?? null

    // Leg progress comes from the engine accumulator, which is only meaningful when the
    // engine's current epoch is the trip in scope (always true pre-trips).
    const { rows: engine } = await app.pool.query('SELECT data FROM engine_state WHERE id = 1')
    const engineMatchesScope = engine.length === 1 && (engine[0].data.trip_id ?? null) === scope
    const legMiles = engineMatchesScope ? Number(engine[0].data.leg_miles ?? 0) : 0

    return {
      current,
      start: first ? { lat: first.lat, lon: first.lon } : null,
      active_destination: active,
      remaining_mi:
        current && active
          ? haversineMiles(current, { lat: Number(active.lat), lon: Number(active.lon) })
          : null,
      leg_miles: legMiles,
      breadcrumb,
    }
  })
}
