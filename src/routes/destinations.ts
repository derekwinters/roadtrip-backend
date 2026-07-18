import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db.js'
import { requireParent, requireProfile } from '../auth.js'
import { appendEvent } from '../events/store.js'
import { conflict, notFound } from '../errors.js'
import { activeTripId } from '../trips/scope.js'

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    order_index: z.number().int().optional(),
  })
  .strict()

const updateSchema = createSchema.partial()

// TRIP-014: ?trip=<id> targets a specific trip's destination list (staging a planned trip).
const tripQuerySchema = z.object({ trip: z.string().uuid().optional() })

/** Loads a trip row for ?trip= targeting; unknown ids are 404 (TRIP-014). */
async function loadTrip(db: Db, id: string): Promise<{ id: string; status: string }> {
  const { rows } = await db.query('SELECT id, status FROM trips WHERE id = $1', [id])
  if (rows.length === 0) throw notFound('Trip')
  return rows[0]
}

/** The destination row, additionally checked against ?trip= when given (TRIP-014). */
async function loadDestination(db: Db, id: string, tripParam?: string) {
  const { rows } = await db.query('SELECT id, status, trip_id FROM destinations WHERE id = $1', [id])
  if (rows.length === 0) throw notFound('Destination')
  if (tripParam !== undefined) {
    await loadTrip(db, tripParam)
    if (rows[0].trip_id !== tripParam) throw notFound('Destination')
  }
  return rows[0]
}

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

/**
 * Destinations of one trip's pool: the active trip by default (or the unassociated pool
 * between trips, TRIP-005), or an explicit trip's list — including a planned trip's
 * staged one (TRIP-014).
 */
async function listDestinations(db: Db, tripId: string | null) {
  const { rows } = await db.query(
    `SELECT id, name, lat, lon, order_index, status, arrived_at FROM destinations
     WHERE trip_id IS NOT DISTINCT FROM $1
     ORDER BY order_index, created_at`,
    [tripId],
  )
  return rows
}

export async function destinationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/destinations', { preHandler: [requireProfile] }, async (req) => {
    const q = tripQuerySchema.parse(req.query)
    if (q.trip !== undefined) {
      await loadTrip(app.pool, q.trip) // 404 on unknown ids (TRIP-014)
      return listDestinations(app.pool, q.trip)
    }
    return listDestinations(app.pool, await activeTripId(app.pool))
  })

  app.post('/api/destinations', { preHandler: [requireParent] }, async (req, reply) => {
    const q = tripQuerySchema.parse(req.query)
    const body = createSchema.parse(req.body)
    // TRIP-005: by default the destination belongs to the trip active at its creation
    // (or none). TRIP-014: ?trip= stages it against the planned trip instead.
    let tripId: string | null
    if (q.trip !== undefined) {
      const trip = await loadTrip(app.pool, q.trip)
      if (trip.status !== 'planned') {
        throw conflict('conflict', 'Destinations can only be staged against a planned trip')
      }
      tripId = trip.id
    } else {
      tripId = await activeTripId(app.pool)
    }
    const orderIndex =
      body.order_index ??
      Number(
        (
          await app.pool.query(
            `SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM destinations
             WHERE trip_id IS NOT DISTINCT FROM $1`,
            [tripId],
          )
        ).rows[0].next,
      )
    const { rows } = await app.pool.query(
      `INSERT INTO destinations (name, lat, lon, order_index, trip_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, lat, lon, order_index, status, arrived_at`,
      [body.name, body.lat, body.lon, orderIndex, tripId],
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
    const q = tripQuerySchema.parse(req.query)
    const body = updateSchema.parse(req.body)
    await loadDestination(app.pool, id, q.trip)
    await app.pool.query(
      `UPDATE destinations SET
         name = COALESCE($2, name), lat = COALESCE($3, lat), lon = COALESCE($4, lon),
         order_index = COALESCE($5, order_index)
       WHERE id = $1`,
      [id, body.name ?? null, body.lat ?? null, body.lon ?? null, body.order_index ?? null],
    )
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
    const q = tripQuerySchema.parse(req.query)
    const row = await loadDestination(app.pool, id, q.trip)
    if (row.status === 'arrived') throw conflict('conflict', 'Cannot remove an arrived destination')
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
