import type { Db } from '../db.js'
import { pathMiles } from '../location/geo.js'

/**
 * Trip aggregation (SUM-002, TRIP-008). With a trip id the aggregation partitions the
 * event stream by the stored trip_id (no double counting across trips); with null it
 * reproduces the pre-trips whole-stream behavior exactly (backward compatibility when
 * no trips exist).
 */
export interface TripSummary {
  miles: number
  wall_minutes: number
  moving_minutes: number
  states_count: number
  stop_count: number
  games_played: number
  wins_by_profile: Record<string, number>
  journal_posts_by_profile: Record<string, number>
}

export async function computeTripSummary(db: Db, tripId: string | null): Promise<TripSummary> {
  const scoped = tripId !== null
  const args = scoped ? [tripId] : []
  const eventCond = scoped ? 'AND trip_id = $1' : ''

  const pingAgg = (
    await db.query(
      scoped
        ? `SELECT COUNT(*)::int AS n,
                  EXTRACT(EPOCH FROM (MAX(p.client_ts) - MIN(p.client_ts))) / 60 AS wall_minutes
           FROM pings p JOIN events e ON e.seq = p.seq WHERE e.trip_id = $1`
        : `SELECT COUNT(*)::int AS n,
                  EXTRACT(EPOCH FROM (MAX(client_ts) - MIN(client_ts))) / 60 AS wall_minutes
           FROM pings`,
      args,
    )
  ).rows[0]
  const wallMinutes = pingAgg.n >= 2 ? Number(pingAgg.wall_minutes) : 0

  const stopAgg = (
    await db.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(duration_min), 0)::float8 AS minutes
       FROM stops WHERE journal_worthy = TRUE ${scoped ? 'AND trip_id = $1' : ''}`,
      args,
    )
  ).rows[0]

  const statesCount = Number(
    (
      await db.query(
        `SELECT COUNT(DISTINCT payload->>'state_code')::int AS n
         FROM events WHERE type = 'location.crossing.state' ${eventCond}`,
        args,
      )
    ).rows[0].n,
  )

  const gamesPlayed = Number(
    (
      await db.query(`SELECT COUNT(*)::int AS n FROM events WHERE type = 'game.finished' ${eventCond}`, args)
    ).rows[0].n,
  )

  const winsByProfile: Record<string, number> = {}
  for (const row of (
    await db.query(
      `SELECT payload->>'winner_profile_id' AS profile_id, COUNT(*)::int AS n
       FROM events
       WHERE type = 'game.finished' AND payload->>'winner_profile_id' IS NOT NULL ${eventCond}
       GROUP BY 1`,
      args,
    )
  ).rows) {
    winsByProfile[row.profile_id] = Number(row.n)
  }

  const postsByProfile: Record<string, number> = {}
  for (const row of (
    await db.query(
      `SELECT actor_id, COUNT(*)::int AS n FROM events
       WHERE type = 'journal.post' AND actor_id IS NOT NULL ${eventCond} GROUP BY actor_id`,
      args,
    )
  ).rows) {
    postsByProfile[row.actor_id] = Number(row.n)
  }

  let miles: number
  if (scoped) {
    // Per-trip mileage is the haversine sum over the trip's own breadcrumb (LOC-007).
    const { rows } = await db.query(
      `SELECT p.lat, p.lon FROM pings p JOIN events e ON e.seq = p.seq
       WHERE e.trip_id = $1 ORDER BY p.client_ts, p.seq`,
      args,
    )
    miles = pathMiles(rows.map((r: any) => ({ lat: Number(r.lat), lon: Number(r.lon) })))
  } else {
    const { rows: engine } = await db.query('SELECT data FROM engine_state WHERE id = 1')
    miles = engine.length === 1 ? Number(engine[0].data.trip_miles ?? 0) : 0
  }

  return {
    miles,
    wall_minutes: wallMinutes,
    moving_minutes: Math.max(0, wallMinutes - Number(stopAgg.minutes)),
    states_count: statesCount,
    stop_count: Number(stopAgg.n),
    games_played: gamesPlayed,
    wins_by_profile: winsByProfile,
    journal_posts_by_profile: postsByProfile,
  }
}
