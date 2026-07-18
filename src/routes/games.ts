import type { FastifyInstance } from 'fastify'
import { requireProfile } from '../auth.js'

/** GAME-001..017 game platform routes. OWNER: games feature. */
export async function gameRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/games', { preHandler: [requireProfile] }, async () => [])
  app.post('/api/games', { preHandler: [requireProfile] }, async (_req, reply) => reply.status(501).send({ error: { code: 'not_implemented', message: 'games not implemented yet' } }))
  app.get('/api/games/:id', { preHandler: [requireProfile] }, async (_req, reply) => reply.status(501).send({ error: { code: 'not_implemented', message: 'games not implemented yet' } }))
  app.post('/api/games/:id/join', { preHandler: [requireProfile] }, async (_req, reply) => reply.status(501).send({ error: { code: 'not_implemented', message: 'games not implemented yet' } }))
  app.post('/api/games/:id/moves', { preHandler: [requireProfile] }, async (_req, reply) => reply.status(501).send({ error: { code: 'not_implemented', message: 'games not implemented yet' } }))
  app.post('/api/games/:id/resign', { preHandler: [requireProfile] }, async (_req, reply) => reply.status(501).send({ error: { code: 'not_implemented', message: 'games not implemented yet' } }))
  app.get('/api/games/:id/events', { preHandler: [requireProfile] }, async () => ({ events: [], next_after: 0 }))
}
