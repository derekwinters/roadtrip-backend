import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireProfile } from '../auth.js'
import { notFound } from '../errors.js'

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : v

const LEG_SELECT = `
  SELECT l.leg_index, l.destination_id, d.name AS destination_name,
         l.started_at, l.arrived_at, l.summary
  FROM legs l LEFT JOIN destinations d ON d.id = l.destination_id`

function toWire(row: any) {
  return {
    leg_index: Number(row.leg_index),
    destination_id: row.destination_id,
    destination_name: row.destination_name ?? null,
    started_at: iso(row.started_at),
    arrived_at: iso(row.arrived_at),
    summary: row.summary,
  }
}

/** SUM-001: completed legs with their trip.leg.arrived summaries. */
export async function legRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/legs', { preHandler: [requireProfile] }, async () => {
    const { rows } = await app.pool.query(`${LEG_SELECT} ORDER BY l.leg_index`)
    return rows.map(toWire)
  })

  app.get('/api/legs/:destinationId', { preHandler: [requireProfile] }, async (req) => {
    const { destinationId } = z.object({ destinationId: z.string().uuid() }).parse(req.params)
    const { rows } = await app.pool.query(`${LEG_SELECT} WHERE l.destination_id = $1`, [destinationId])
    if (rows.length === 0) throw notFound('Leg')
    return toWire(rows[0])
  })
}
