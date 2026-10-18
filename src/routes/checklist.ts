import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireProfile } from '../auth.js'
import { resolveTripScope } from '../trips/scope.js'

const querySchema = z.object({ trip: z.guid().optional() })

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : v)

/**
 * LIST-001/002/003: states driven through (first-entered timestamp), cities passed, and
 * ended stops that are journal-worthy or labeled — all derived from crossing/stop/label data
 * of the event stream, scoped to the trip in scope (TRIP-007; unscoped when no trips exist).
 */
export async function checklistRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/checklist', { preHandler: [requireProfile] }, async (req) => {
    const q = querySchema.parse(req.query)
    const scope = await resolveTripScope(app.pool, q.trip)
    const args = scope !== null ? [scope] : []
    const eventCond = scope !== null ? 'AND trip_id = $1' : ''
    const rowCond = scope !== null ? 'AND trip_id = $1' : ''
    const stopCond = scope !== null ? 'AND s.trip_id = $1' : ''

    // LIST-002: one row per state, keyed on the FIRST crossing even after re-entries.
    const { rows: stateRows } = await app.pool.query(
      `SELECT DISTINCT ON (payload->>'state_code')
              payload->>'state' AS state, payload->>'state_code' AS state_code, client_ts
       FROM events WHERE type = 'location.crossing.state' ${eventCond}
       ORDER BY payload->>'state_code', client_ts, seq`,
      args,
    )
    const states = stateRows
      .map((r: any) => ({ state: r.state, state_code: r.state_code, first_entered_at: iso(r.client_ts) }))
      .sort((a, b) => a.first_entered_at.localeCompare(b.first_entered_at))

    const { rows: cityRows } = await app.pool.query(
      `SELECT city, state_code, first_at FROM cities_visited WHERE TRUE ${rowCond} ORDER BY first_at, city`,
      args,
    )
    const cities = cityRows.map((r: any) => ({
      city: r.city,
      state_code: r.state_code,
      first_at: iso(r.first_at),
    }))

    // LOC-017: a stop's current label is its latest location.stop.labeled by client_ts (ties by
    // seq), folded in at read time; place and the stop row are never touched.
    const { rows: stopRows } = await app.pool.query(
      `SELECT s.id, s.anchor_lat, s.anchor_lon, s.started_at, s.duration_min, s.place, l.label
       FROM stops s
       LEFT JOIN (
         SELECT DISTINCT ON (payload->>'stop_id') payload->>'stop_id' AS stop_id, payload->>'label' AS label
         FROM events WHERE type = 'location.stop.labeled'
         ORDER BY payload->>'stop_id', client_ts DESC, seq DESC
       ) l ON l.stop_id = s.id::text
       WHERE s.ended_at IS NOT NULL AND (s.journal_worthy = TRUE OR l.label IS NOT NULL) ${stopCond}
       ORDER BY s.started_at`,
      args,
    )
    const stops = stopRows.map((r: any) => ({
      stop_id: r.id as string,
      lat: Number(r.anchor_lat),
      lon: Number(r.anchor_lon),
      started_at: iso(r.started_at),
      duration_min: Number(r.duration_min),
      place: r.place ?? null,
      ...(r.label !== null ? { label: r.label as string } : {}), // LOC-017: absent when never labeled
    }))

    return { states, cities, stops }
  })
}
