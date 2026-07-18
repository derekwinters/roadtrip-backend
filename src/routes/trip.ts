import type { FastifyInstance } from 'fastify'
import { requireProfile } from '../auth.js'

/** SUM-002/003 whole-trip aggregation. OWNER: location feature. */
export async function tripRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/trip/summary', { preHandler: [requireProfile] }, async () => {
    return {
      miles: 0,
      wall_minutes: 0,
      moving_minutes: 0,
      states_count: 0,
      stop_count: 0,
      games_played: 0,
      wins_by_profile: {},
      journal_posts_by_profile: {},
    }
  })
}
