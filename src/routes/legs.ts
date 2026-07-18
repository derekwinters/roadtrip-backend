import type { FastifyInstance } from 'fastify'
import { requireProfile } from '../auth.js'

/** SUM-001 leg summaries. OWNER: location feature. */
export async function legRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/legs', { preHandler: [requireProfile] }, async () => [])
  app.get('/api/legs/:destinationId', { preHandler: [requireProfile] }, async () => {
    return {}
  })
}
