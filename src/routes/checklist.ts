import type { FastifyInstance } from 'fastify'
import { requireProfile } from '../auth.js'

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : v)

/**
 * LIST-001/002: states driven through (first-entered timestamp), cities passed, and
 * journal-worthy stops — all derived from crossing/stop data of the event stream.
 */
export async function checklistRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/checklist', { preHandler: [requireProfile] }, async () => {
    // LIST-002: one row per state, keyed on the FIRST crossing even after re-entries.
    const { rows: stateRows } = await app.pool.query(
      `SELECT DISTINCT ON (payload->>'state_code')
              payload->>'state' AS state, payload->>'state_code' AS state_code, client_ts
       FROM events WHERE type = 'location.crossing.state'
       ORDER BY payload->>'state_code', client_ts, seq`,
    )
    const states = stateRows
      .map((r: any) => ({ state: r.state, state_code: r.state_code, first_entered_at: iso(r.client_ts) }))
      .sort((a, b) => a.first_entered_at.localeCompare(b.first_entered_at))

    const { rows: cityRows } = await app.pool.query(
      'SELECT city, state_code, first_at FROM cities_visited ORDER BY first_at, city',
    )
    const cities = cityRows.map((r: any) => ({
      city: r.city,
      state_code: r.state_code,
      first_at: iso(r.first_at),
    }))

    const { rows: stopRows } = await app.pool.query(
      `SELECT anchor_lat, anchor_lon, started_at, duration_min, place
       FROM stops WHERE journal_worthy = TRUE ORDER BY started_at`,
    )
    const stops = stopRows.map((r: any) => ({
      lat: Number(r.anchor_lat),
      lon: Number(r.anchor_lon),
      started_at: iso(r.started_at),
      duration_min: Number(r.duration_min),
      place: r.place ?? null,
    }))

    return { states, cities, stops }
  })
}
