import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db.js'
import { requireParent, requireProfile } from '../auth.js'
import { appendEvent } from '../events/store.js'
import { conflict, notFound } from '../errors.js'
import { computeTripSummary } from '../trips/summary.js'
import { reconcileActiveDestination } from './destinations.js'

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    status: z.enum(['active', 'planned']).optional(),
    planned_start_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((v) => v.status === 'planned' || v.planned_start_at === undefined, {
    message: 'planned_start_at requires status "planned"',
    path: ['planned_start_at'],
  })
const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    planned_start_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.planned_start_at !== undefined, { message: 'Nothing to update' })
const idSchema = z.object({ id: z.string().uuid() })

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : v

function toWire(row: any) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    started_at: iso(row.started_at),
    ended_at: iso(row.ended_at),
    planned_start_at: iso(row.planned_start_at ?? null),
  }
}

const SELECT = 'SELECT id, name, status, started_at, ended_at, planned_start_at FROM trips'

async function loadTrip(db: Db, id: string) {
  const { rows } = await db.query(`${SELECT} WHERE id = $1`, [id])
  if (rows.length === 0) throw notFound('Trip')
  return rows[0]
}

/**
 * Trip lifecycle (docs/spec/12-trips.md, TRIP-001..003), planned trips (TRIP-013..017),
 * and the per-trip summary (TRIP-008).
 */
export async function tripsRoutes(app: FastifyInstance): Promise<void> {
  // TRIP-003 — list trips, oldest first (planned trips have no start and sort last).
  app.get('/api/trips', { preHandler: [requireProfile] }, async () => {
    const { rows } = await app.pool.query(`${SELECT} ORDER BY started_at, id`)
    return rows.map(toWire)
  })

  // TRIP-001 — start a trip (parent-only, single active trip).
  // TRIP-013 — status:"planned" stages one instead: no window, no lifecycle event yet.
  app.post('/api/trips', { preHandler: [requireParent] }, async (req, reply) => {
    const body = createSchema.parse(req.body ?? {})

    if (body.status === 'planned') {
      const plannedStartAt = body.planned_start_at ? new Date(body.planned_start_at) : null
      const name = body.name ?? `Road Trip ${(plannedStartAt ?? new Date()).toISOString().slice(0, 10)}`
      const client = await app.pool.connect()
      let row: any
      try {
        await client.query('BEGIN')
        const planned = await client.query(`SELECT 1 FROM trips WHERE status = 'planned' FOR UPDATE`)
        if ((planned.rowCount ?? 0) > 0) throw conflict('conflict', 'A trip is already planned')
        const inserted = await client.query(
          `INSERT INTO trips (name, status, started_at, planned_start_at)
           VALUES ($1, 'planned', NULL, $2)
           RETURNING id, name, status, started_at, ended_at, planned_start_at`,
          [name, plannedStartAt],
        )
        row = inserted.rows[0]
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
      app.bus.notify()
      return reply.status(201).send(toWire(row))
    }

    const startedAt = new Date()
    const name = body.name ?? `Road Trip ${startedAt.toISOString().slice(0, 10)}`

    const client = await app.pool.connect()
    let row: any
    try {
      await client.query('BEGIN')
      const active = await client.query(`SELECT 1 FROM trips WHERE status = 'active' FOR UPDATE`)
      if ((active.rowCount ?? 0) > 0) throw conflict('conflict', 'A trip is already active')
      const inserted = await client.query(
        `INSERT INTO trips (name, status, started_at) VALUES ($1, 'active', $2)
         RETURNING id, name, status, started_at, ended_at, planned_start_at`,
        [name, startedAt],
      )
      row = inserted.rows[0]
      // Appended while the window is open, so the event associates with its own trip.
      await appendEvent(client, {
        type: 'trip.started',
        actorId: req.profile!.id,
        payload: { trip_id: row.id, name },
        clientTs: startedAt,
      })
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    app.bus.notify()
    return reply.status(201).send(toWire(row))
  })

  // TRIP-003 — rename (parent-only). The lifecycle events keep the start/end-time names.
  // TRIP-016 — while planned, planned_start_at can be updated too (informational only).
  app.patch('/api/trips/:id', { preHandler: [requireParent] }, async (req) => {
    const { id } = idSchema.parse(req.params)
    const body = patchSchema.parse(req.body)
    const existing = await app.pool.query(`${SELECT} WHERE id = $1`, [id])
    if (existing.rows.length === 0) throw notFound('Trip')
    if (body.planned_start_at !== undefined && existing.rows[0].status !== 'planned') {
      throw conflict('conflict', 'planned_start_at can only be set on a planned trip')
    }
    const { rows } = await app.pool.query(
      `UPDATE trips SET name = COALESCE($2, name),
              planned_start_at = CASE WHEN $3 THEN $4::timestamptz ELSE planned_start_at END
       WHERE id = $1 RETURNING id, name, status, started_at, ended_at, planned_start_at`,
      [id, body.name ?? null, body.planned_start_at !== undefined, body.planned_start_at ?? null],
    )
    app.bus.notify()
    return toWire(rows[0])
  })

  // TRIP-015 — activate a planned trip: the window opens now, trip.started is emitted,
  // and the staged destinations (already carrying this trip_id) become the active list.
  app.post('/api/trips/:id/start', { preHandler: [requireParent] }, async (req) => {
    const { id } = idSchema.parse(req.params)
    const client = await app.pool.connect()
    let row: any
    try {
      await client.query('BEGIN')
      const existing = await client.query(`${SELECT} WHERE id = $1 FOR UPDATE`, [id])
      if (existing.rows.length === 0) throw notFound('Trip')
      if (existing.rows[0].status !== 'planned') throw conflict('conflict', 'Trip is not planned')
      const active = await client.query(`SELECT 1 FROM trips WHERE status = 'active' FOR UPDATE`)
      if ((active.rowCount ?? 0) > 0) throw conflict('conflict', 'A trip is already active')

      const startedAt = new Date()
      const updated = await client.query(
        `UPDATE trips SET status = 'active', started_at = $2 WHERE id = $1
         RETURNING id, name, status, started_at, ended_at, planned_start_at`,
        [id, startedAt],
      )
      row = updated.rows[0]
      await appendEvent(client, {
        type: 'trip.started',
        actorId: req.profile!.id,
        payload: { trip_id: id, name: row.name },
        clientTs: startedAt,
      })
      // Adoption: the first staged destination becomes the active one (TRIP-015).
      await reconcileActiveDestination(client)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    app.bus.notify()
    return toWire(row)
  })

  // TRIP-017 — delete a planned trip and its staged destinations (active/ended are 409).
  app.delete('/api/trips/:id', { preHandler: [requireParent] }, async (req, reply) => {
    const { id } = idSchema.parse(req.params)
    const client = await app.pool.connect()
    try {
      await client.query('BEGIN')
      const existing = await client.query(`SELECT status FROM trips WHERE id = $1 FOR UPDATE`, [id])
      if (existing.rows.length === 0) throw notFound('Trip')
      if (existing.rows[0].status !== 'planned') throw conflict('conflict', 'Only planned trips can be deleted')
      await client.query('DELETE FROM destinations WHERE trip_id = $1', [id])
      await client.query('DELETE FROM trips WHERE id = $1', [id])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    app.bus.notify()
    return reply.status(204).send()
  })

  // TRIP-002 — end the active trip (parent-only; ending a non-active trip is 409).
  app.post('/api/trips/:id/end', { preHandler: [requireParent] }, async (req) => {
    const { id } = idSchema.parse(req.params)
    const client = await app.pool.connect()
    let row: any
    try {
      await client.query('BEGIN')
      const existing = await client.query(`${SELECT} WHERE id = $1 FOR UPDATE`, [id])
      if (existing.rows.length === 0) throw notFound('Trip')
      if (existing.rows[0].status !== 'active') throw conflict('conflict', 'Trip is not active')

      const endedAt = new Date()
      // Freeze the headline totals into the event for the journal entry (TRIP-009).
      const summary = await computeTripSummary(client, id)
      // Appended before the window closes, so trip.ended belongs to its own trip.
      await appendEvent(client, {
        type: 'trip.ended',
        actorId: req.profile!.id,
        payload: {
          trip_id: id,
          name: existing.rows[0].name,
          miles: summary.miles,
          states_count: summary.states_count,
        },
        clientTs: endedAt,
      })
      const updated = await client.query(
        `UPDATE trips SET status = 'ended', ended_at = $2 WHERE id = $1
         RETURNING id, name, status, started_at, ended_at`,
        [id, endedAt],
      )
      row = updated.rows[0]
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    app.bus.notify()
    return toWire(row)
  })

  // TRIP-008 — aggregation scoped to exactly one trip.
  app.get('/api/trips/:id/summary', { preHandler: [requireProfile] }, async (req) => {
    const { id } = idSchema.parse(req.params)
    await loadTrip(app.pool, id)
    return computeTripSummary(app.pool, id)
  })
}
