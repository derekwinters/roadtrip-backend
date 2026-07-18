import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db.js'
import { requireParent, requireProfile } from '../auth.js'
import { appendEvent } from '../events/store.js'
import { conflict, notFound } from '../errors.js'
import { computeTripSummary } from '../trips/summary.js'

const createSchema = z.object({ name: z.string().trim().min(1).max(80).optional() }).strict()
const renameSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict()
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
  }
}

const SELECT = 'SELECT id, name, status, started_at, ended_at FROM trips'

async function loadTrip(db: Db, id: string) {
  const { rows } = await db.query(`${SELECT} WHERE id = $1`, [id])
  if (rows.length === 0) throw notFound('Trip')
  return rows[0]
}

/** Trip lifecycle (docs/spec/12-trips.md, TRIP-001..003) + per-trip summary (TRIP-008). */
export async function tripsRoutes(app: FastifyInstance): Promise<void> {
  // TRIP-003 — list trips, oldest first.
  app.get('/api/trips', { preHandler: [requireProfile] }, async () => {
    const { rows } = await app.pool.query(`${SELECT} ORDER BY started_at, id`)
    return rows.map(toWire)
  })

  // TRIP-001 — start a trip (parent-only, single active trip).
  app.post('/api/trips', { preHandler: [requireParent] }, async (req, reply) => {
    const body = createSchema.parse(req.body ?? {})
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
         RETURNING id, name, status, started_at, ended_at`,
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
  app.patch('/api/trips/:id', { preHandler: [requireParent] }, async (req) => {
    const { id } = idSchema.parse(req.params)
    const body = renameSchema.parse(req.body)
    const { rows } = await app.pool.query(
      `UPDATE trips SET name = $2 WHERE id = $1 RETURNING id, name, status, started_at, ended_at`,
      [id, body.name],
    )
    if (rows.length === 0) throw notFound('Trip')
    app.bus.notify()
    return toWire(rows[0])
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
