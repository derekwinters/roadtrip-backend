import type { Db } from '../db.js'
import { notFound } from '../errors.js'

/**
 * Trip scoping helpers (docs/spec/12-trips.md). A trip's window is
 * [started_at, ended_at) — start inclusive, end exclusive (TRIP-004).
 */

export interface TripWindow {
  id: string
  startedAtMs: number
  endedAtMs: number | null
}

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v))

/** Loads every trip window; the engine resolves epochs against this per batch (TRIP-006). */
export async function loadTripWindows(db: Db): Promise<TripWindow[]> {
  const { rows } = await db.query('SELECT id, started_at, ended_at FROM trips')
  return rows.map((r: any) => ({
    id: r.id,
    startedAtMs: ms(r.started_at),
    endedAtMs: r.ended_at === null ? null : ms(r.ended_at),
  }))
}

/** The trip whose window contains the timestamp, or null (windows never overlap). */
export function tripAt(windows: TripWindow[], tsMs: number): string | null {
  for (const w of windows) {
    if (w.startedAtMs <= tsMs && (w.endedAtMs === null || w.endedAtMs > tsMs)) return w.id
  }
  return null
}

/** The currently active trip's id, or null when none is active. */
export async function activeTripId(db: Db): Promise<string | null> {
  const { rows } = await db.query(`SELECT id FROM trips WHERE status = 'active' LIMIT 1`)
  return rows.length > 0 ? rows[0].id : null
}

/**
 * Read-model scope (TRIP-007): an explicit ?trip=<id> wins (404 on unknown ids);
 * otherwise the active trip, else the most recently ended one. Returns null — legacy
 * unscoped behavior — only when no trips exist at all.
 */
export async function resolveTripScope(db: Db, tripParam?: string): Promise<string | null> {
  if (tripParam) {
    const { rows } = await db.query('SELECT id FROM trips WHERE id = $1', [tripParam])
    if (rows.length === 0) throw notFound('Trip')
    return rows[0].id
  }
  const { rows } = await db.query(
    `SELECT id FROM trips
     ORDER BY (status = 'active') DESC, ended_at DESC NULLS LAST, started_at DESC
     LIMIT 1`,
  )
  return rows.length > 0 ? rows[0].id : null
}
