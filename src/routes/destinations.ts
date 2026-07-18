import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db.js'
import { requireParent, requireProfile } from '../auth.js'
import { appendEvent } from '../events/store.js'
import { conflict, notFound } from '../errors.js'

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    order_index: z.number().int().optional(),
  })
  .strict()

const updateSchema = createSchema.partial()

/**
 * Keeps exactly one active destination: the lowest-ordered non-arrived one belonging to
 * the currently active trip — or to no trip when none is active, so the tracker still
 * works between trips (TRIP-005/010). Identical to the pre-trips rule when no trips exist.
 */
export async function reconcileActiveDestination(db: Db): Promise<void> {
  await db.query(`UPDATE destinations SET status = 'pending' WHERE status = 'active'`)
  await db.query(
    `UPDATE destinations SET status = 'active'
     WHERE id = (SELECT id FROM destinations
                 WHERE status <> 'arrived'
                   AND trip_id IS NOT DISTINCT FROM (SELECT id FROM trips WHERE status = 'active' LIMIT 1)
                 ORDER BY order_index, created_at LIMIT 1)`,
  )
}

/** Destinations of the active trip, or the unassociated pool between trips (TRIP-005). */
async function listDestinations(db: Db) {
  const { rows } = await db.query(
    `SELECT id, name, lat, lon, order_index, status, arrived_at FROM destinations
     WHERE trip_id IS NOT DISTINCT FROM (SELECT id FROM trips WHERE status = 'active' LIMIT 1)
     ORDER BY order_index, created_at`,
  )
  return rows
}

export async function destinationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/destinations', { preHandler: [requireProfile] }, async () => listDestinations(app.pool))

  app.post('/api/destinations', { preHandler: [requireParent] }, async (req, reply) => {
    const body = createSchema.parse(req.body)
    const orderIndex =
      body.order_index ??
      Number(
        (
          await app.pool.query(
            `SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM destinations
             WHERE trip_id IS NOT DISTINCT FROM (SELECT id FROM trips WHERE status = 'active' LIMIT 1)`,
          )
        ).rows[0].next,
      )
    // TRIP-005: the destination belongs to the trip active at its creation (or none).
    const { rows } = await app.pool.query(
      `INSERT INTO destinations (name, lat, lon, order_index, trip_id)
       VALUES ($1, $2, $3, $4, (SELECT id FROM trips WHERE status = 'active' LIMIT 1))
       RETURNING id, name, lat, lon, order_index, status, arrived_at`,
      [body.name, body.lat, body.lon, orderIndex],
    )
    await reconcileActiveDestination(app.pool)
    await appendEvent(app.pool, {
      type: 'destination.added',
      actorId: req.profile!.id,
      payload: { destination_id: rows[0].id, name: body.name, lat: body.lat, lon: body.lon, order_index: orderIndex },
      clientTs: new Date(),
    })
    app.bus.notify()
    const fresh = await app.pool.query(
      'SELECT id, name, lat, lon, order_index, status, arrived_at FROM destinations WHERE id = $1',
      [rows[0].id],
    )
    return reply.status(201).send(fresh.rows[0])
  })

  app.patch('/api/destinations/:id', { preHandler: [requireParent] }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = updateSchema.parse(req.body)
    const { rows } = await app.pool.query(
      `UPDATE destinations SET
         name = COALESCE($2, name), lat = COALESCE($3, lat), lon = COALESCE($4, lon),
         order_index = COALESCE($5, order_index)
       WHERE id = $1 RETURNING id`,
      [id, body.name ?? null, body.lat ?? null, body.lon ?? null, body.order_index ?? null],
    )
    if (rows.length === 0) throw notFound('Destination')
    await reconcileActiveDestination(app.pool)
    await appendEvent(app.pool, {
      type: 'destination.updated',
      actorId: req.profile!.id,
      payload: { destination_id: id, ...body },
      clientTs: new Date(),
    })
    app.bus.notify()
    const fresh = await app.pool.query(
      'SELECT id, name, lat, lon, order_index, status, arrived_at FROM destinations WHERE id = $1',
      [id],
    )
    return fresh.rows[0]
  })

  app.delete('/api/destinations/:id', { preHandler: [requireParent] }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { rows } = await app.pool.query('SELECT status FROM destinations WHERE id = $1', [id])
    if (rows.length === 0) throw notFound('Destination')
    if (rows[0].status === 'arrived') throw conflict('conflict', 'Cannot remove an arrived destination')
    await app.pool.query('DELETE FROM destinations WHERE id = $1', [id])
    await reconcileActiveDestination(app.pool)
    await appendEvent(app.pool, {
      type: 'destination.removed',
      actorId: req.profile!.id,
      payload: { destination_id: id },
      clientTs: new Date(),
    })
    app.bus.notify()
    return reply.status(204).send()
  })
}
