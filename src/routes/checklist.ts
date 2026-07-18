import type { FastifyInstance } from 'fastify'
import { requireProfile } from '../auth.js'

/** LIST-001/002 checklist read model. OWNER: location feature. */
export async function checklistRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/checklist', { preHandler: [requireProfile] }, async () => {
    return { states: [], cities: [], stops: [] }
  })
}
