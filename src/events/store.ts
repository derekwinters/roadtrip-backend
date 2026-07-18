import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'

export interface AppendInput {
  eventId?: string
  type: string
  actorId?: string | null
  deviceId?: string | null
  payload: unknown
  clientTs: string | Date
}

export interface EventRow {
  seq: number
  event_id: string
  type: string
  actor_id: string | null
  device_id: string | null
  payload: any
  client_ts: string
  server_ts: string
}

export type AppendResult = { status: 'inserted'; seq: number } | { status: 'duplicate'; seq: number }

/**
 * Appends an event. Idempotent on event_id (EVT-001): a replayed event is reported as
 * `duplicate` and the stored row is untouched. Callers notify the bus after commit.
 */
export async function appendEvent(db: Db, input: AppendInput): Promise<AppendResult> {
  const eventId = input.eventId ?? randomUUID()
  const inserted = await db.query(
    `INSERT INTO events (event_id, type, actor_id, device_id, payload, client_ts)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING seq`,
    [eventId, input.type, input.actorId ?? null, input.deviceId ?? null, JSON.stringify(input.payload ?? {}), input.clientTs],
  )
  if (inserted.rowCount === 1) return { status: 'inserted', seq: Number(inserted.rows[0].seq) }
  const existing = await db.query('SELECT seq FROM events WHERE event_id = $1', [eventId])
  return { status: 'duplicate', seq: Number(existing.rows[0].seq) }
}

export interface ListParams {
  after?: number
  limit?: number
  types?: string[]
  /** Extra SQL filter on the payload, e.g. game scoping. */
  payloadFilter?: { path: string; value: string }
}

export function rowToWire(row: any): EventRow {
  return {
    seq: Number(row.seq),
    event_id: row.event_id,
    type: row.type,
    actor_id: row.actor_id,
    device_id: row.device_id,
    payload: row.payload,
    client_ts: row.client_ts instanceof Date ? row.client_ts.toISOString() : row.client_ts,
    server_ts: row.server_ts instanceof Date ? row.server_ts.toISOString() : row.server_ts,
  }
}

/** Events in seq order after the exclusive cursor (EVT-002, EVT-007). */
export async function listEvents(db: Db, params: ListParams): Promise<EventRow[]> {
  const clauses = ['seq > $1']
  const args: unknown[] = [params.after ?? 0]
  if (params.types && params.types.length > 0) {
    args.push(params.types)
    clauses.push(`type = ANY($${args.length})`)
  }
  if (params.payloadFilter) {
    args.push(params.payloadFilter.value)
    clauses.push(`payload->>'${params.payloadFilter.path}' = $${args.length}`)
  }
  args.push(Math.min(params.limit ?? 200, 500))
  const { rows } = await db.query(
    `SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq LIMIT $${args.length}`,
    args,
  )
  return rows.map(rowToWire)
}
