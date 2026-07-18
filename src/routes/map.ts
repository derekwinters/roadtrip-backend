import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireProfile } from '../auth.js'
import { decimate, haversineMiles } from '../location/geo.js'

const querySchema = z.object({
  max_points: z.coerce.number().int().min(2).max(10_000).default(500),
})

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : v)

/** LOC-008: latest position, trip start, breadcrumb, active destination, leg progress. */
export async function mapRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/map', { preHandler: [requireProfile] }, async (req) => {
    const q = querySchema.parse(req.query)

    const { rows: pings } = await app.pool.query(
      'SELECT lat, lon, client_ts FROM pings ORDER BY client_ts, seq',
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
      `SELECT id, name, lat, lon, order_index, status, arrived_at FROM destinations
       WHERE status = 'active' ORDER BY order_index, created_at LIMIT 1`,
    )
    const active = dests[0] ?? null

    const { rows: engine } = await app.pool.query('SELECT data FROM engine_state WHERE id = 1')
    const legMiles = engine.length === 1 ? Number(engine[0].data.leg_miles ?? 0) : 0

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
