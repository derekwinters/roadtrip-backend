import type { FastifyInstance } from 'fastify'
import { requireProfile } from '../auth.js'

/**
 * SUM-002: whole-trip aggregation over the event stream and its read models. The trip
 * totals partition exactly into the completed legs plus the in-progress leg (SUM-003),
 * because leg summaries use the same overlap accounting.
 */
export async function tripRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/trip/summary', { preHandler: [requireProfile] }, async () => {
    const pool = app.pool

    const pingAgg = (
      await pool.query(
        `SELECT COUNT(*)::int AS n,
                EXTRACT(EPOCH FROM (MAX(client_ts) - MIN(client_ts))) / 60 AS wall_minutes
         FROM pings`,
      )
    ).rows[0]
    const wallMinutes = pingAgg.n >= 2 ? Number(pingAgg.wall_minutes) : 0

    const stopAgg = (
      await pool.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(duration_min), 0)::float8 AS minutes
         FROM stops WHERE journal_worthy = TRUE`,
      )
    ).rows[0]

    const statesCount = Number(
      (
        await pool.query(
          `SELECT COUNT(DISTINCT payload->>'state_code')::int AS n
           FROM events WHERE type = 'location.crossing.state'`,
        )
      ).rows[0].n,
    )

    const gamesPlayed = Number(
      (await pool.query(`SELECT COUNT(*)::int AS n FROM events WHERE type = 'game.finished'`)).rows[0].n,
    )

    const winsByProfile: Record<string, number> = {}
    for (const row of (
      await pool.query(
        `SELECT payload->>'winner_profile_id' AS profile_id, COUNT(*)::int AS n
         FROM events
         WHERE type = 'game.finished' AND payload->>'winner_profile_id' IS NOT NULL
         GROUP BY 1`,
      )
    ).rows) {
      winsByProfile[row.profile_id] = Number(row.n)
    }

    const postsByProfile: Record<string, number> = {}
    for (const row of (
      await pool.query(
        `SELECT actor_id, COUNT(*)::int AS n FROM events
         WHERE type = 'journal.post' AND actor_id IS NOT NULL GROUP BY actor_id`,
      )
    ).rows) {
      postsByProfile[row.actor_id] = Number(row.n)
    }

    const { rows: engine } = await pool.query('SELECT data FROM engine_state WHERE id = 1')
    const miles = engine.length === 1 ? Number(engine[0].data.trip_miles ?? 0) : 0

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
  })
}
