import type { FastifyInstance } from 'fastify'
import { requireParent, requireProfile } from '../auth.js'
import { applyConfigChanges, getConfig, validateConfigPatch } from '../config.js'
import { appendEvent } from '../events/store.js'

export async function configRoutes(app: FastifyInstance): Promise<void> {
  // CFG-001
  app.get('/api/config', { preHandler: [requireProfile] }, async () => getConfig(app.pool))

  // CFG-002 / CFG-003 — parent-only, all-or-nothing validation, emits config.updated.
  app.put('/api/config', { preHandler: [requireParent] }, async (req) => {
    const changes = validateConfigPatch((req.body ?? {}) as Record<string, unknown>)
    const client = await app.pool.connect()
    try {
      await client.query('BEGIN')
      await applyConfigChanges(client, changes)
      await appendEvent(client, {
        type: 'config.updated',
        actorId: req.profile!.id,
        payload: { changes },
        clientTs: new Date(),
      })
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    app.bus.notify()
    return getConfig(app.pool)
  })
}
