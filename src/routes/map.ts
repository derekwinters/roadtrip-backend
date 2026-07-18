import type { FastifyInstance } from 'fastify'
import { requireProfile } from '../auth.js'

/** LOC-008 map/progress state. OWNER: location feature. */
export async function mapRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/map', { preHandler: [requireProfile] }, async () => {
    return { current: null, start: null, active_destination: null, remaining_mi: null, leg_miles: 0, breadcrumb: [] }
  })
}
