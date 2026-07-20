/**
 * Location engine (docs/spec/06-location.md). Processes accepted `location.ping` events
 * in client_ts order, deriving stops, state/city crossings, arrivals, mileage, and leg
 * summaries. All thresholds come from runtime config, re-read on every batch (CFG-004).
 *
 * Read models maintained here (all rebuildable from the event stream, SYS-002):
 * pings, stops, cities_visited, legs, and the single-row engine_state accumulator.
 */
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { EventBus } from '../bus.js'
import type { Db } from '../db.js'
import { getConfig, type AppConfig } from '../config.js'
import { appendEvent } from '../events/store.js'
import { reconcileActiveDestination } from '../routes/destinations.js'
import { haversineMeters, haversineMiles } from './geo.js'
import { nearestCityWithin, stateForPoint } from './geocode.js'
import { isJournalWorthy, stepStopMachine, type StopMachineState } from './stop-machine.js'
import { loadTripWindows, tripAt, type TripWindow } from '../trips/scope.js'

/** Serialized as the single engine_state row; every field derives from the ping stream. */
export interface EngineState {
  last_ping: { lat: number; lon: number; ts: string } | null
  open_stop: { id: string; anchor_lat: number; anchor_lon: number; started_at: string } | null
  state_code: string | null
  leg_index: number
  leg_started_at: string | null
  leg_miles: number
  leg_states: string[]
  trip_miles: number
  trip_started_at: string | null
  /** Trip epoch (TRIP-006): the trip whose window contained the last processed ping. */
  trip_id: string | null
}

export interface LegSummary {
  wall_minutes: number
  moving_minutes: number
  miles: number
  stop_count: number
  states: string[]
  games_played: number
}

/** Serializes engine batches across concurrent syncs (per database). */
const ENGINE_LOCK_KEY = 0x726f6164 // "road"

type Emit = (type: string, payload: unknown, clientTs: string) => Promise<void>

interface PingRow {
  seq: number
  lat: number
  lon: number
  accuracyM: number | null
  tsIso: string
  tsMs: number
}

function freshState(): EngineState {
  return {
    last_ping: null,
    open_stop: null,
    state_code: null,
    leg_index: 0,
    leg_started_at: null,
    leg_miles: 0,
    leg_states: [],
    trip_miles: 0,
    trip_started_at: null,
    trip_id: null,
  }
}

async function loadState(db: Db): Promise<EngineState> {
  const { rows } = await db.query('SELECT data FROM engine_state WHERE id = 1')
  if (rows.length !== 1) return freshState()
  const state = rows[0].data as EngineState
  state.trip_id ??= null // rows persisted before the trips feature lack the field
  return state
}

async function saveState(db: Db, state: EngineState): Promise<void> {
  await db.query(
    `INSERT INTO engine_state (id, data) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [JSON.stringify(state)],
  )
}

function toPingRow(row: any): PingRow {
  const ts: Date = row.client_ts instanceof Date ? row.client_ts : new Date(row.client_ts)
  return {
    seq: Number(row.seq),
    lat: Number(row.payload.lat),
    lon: Number(row.payload.lon),
    accuracyM: row.payload.accuracy_m ?? null,
    tsIso: ts.toISOString(),
    tsMs: ts.getTime(),
  }
}

async function insertPingRow(db: Db, ping: PingRow, stateCode: string | null, legIndex: number): Promise<void> {
  await db.query(
    `INSERT INTO pings (seq, lat, lon, accuracy_m, client_ts, state_code, leg_index)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ping.seq, ping.lat, ping.lon, ping.accuracyM, ping.tsIso, stateCode, legIndex],
  )
}

/**
 * TRIP-006: leg numbering continues from what the epoch's scope already has, so a fresh
 * trip starts at leg 0 while the unassociated (NULL) epoch never reuses an index.
 */
async function nextLegIndex(db: Db, tripId: string | null): Promise<number> {
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(leg_index), -1) + 1 AS next FROM legs WHERE trip_id IS NOT DISTINCT FROM $1',
    [tripId],
  )
  return Number(rows[0].next)
}

/**
 * LOC-009: leg summary at arrival. Wall = leg start → arrival; moving = wall minus the
 * journal-worthy stop minutes overlapping the leg window (so a layover at the previous
 * destination counts against the leg it delays); games from `game.finished` client_ts.
 */
async function computeLegSummary(db: Db, state: EngineState, arrivedAtIso: string): Promise<LegSummary> {
  const startIso = state.leg_started_at!
  const wallMinutes = (Date.parse(arrivedAtIso) - Date.parse(startIso)) / 60_000
  const stops = await db.query(
    `SELECT COUNT(*)::int AS stop_count,
            COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(ended_at, $2::timestamptz) - GREATEST(started_at, $1::timestamptz))) / 60), 0)::float8 AS stop_minutes
     FROM stops
     WHERE journal_worthy = TRUE AND ended_at > $1 AND started_at < $2`,
    [startIso, arrivedAtIso],
  )
  // The first leg's window includes its start instant (trip start); later legs start
  // exactly at the previous arrival, which belongs to the previous leg.
  const gameCmp = state.leg_index === 0 ? '>=' : '>'
  const games = await db.query(
    `SELECT COUNT(*)::int AS n FROM events
     WHERE type = 'game.finished' AND client_ts ${gameCmp} $1 AND client_ts <= $2`,
    [startIso, arrivedAtIso],
  )
  return {
    wall_minutes: wallMinutes,
    moving_minutes: Math.max(0, wallMinutes - Number(stops.rows[0].stop_minutes)),
    miles: state.leg_miles,
    stop_count: Number(stops.rows[0].stop_count),
    states: [...state.leg_states],
    games_played: Number(games.rows[0].n),
  }
}

/**
 * LOC-006/LOC-012: while a stop is open, a ping within arrival_radius_m of the ACTIVE
 * destination arrives there exactly once, records the leg, and activates the next pending
 * destination. Distance is measured from `at` (the current ping) rather than only the stop
 * anchor, and the check runs for every ping of the stop's life — so a destination reached
 * after the anchor was laid down, or made active while the vehicle is already parked, still
 * arrives instead of being missed. Arrival is still backdated to the stop's start.
 * The active destination is the lowest-ordered non-arrived one of the engine's trip epoch
 * (TRIP-005/006) — identical to the reconciled `status='active'` row live, and epoch-correct
 * during rebuilds.
 */
async function checkArrival(
  db: Db,
  cfg: AppConfig,
  state: EngineState,
  emit: Emit,
  at: { lat: number; lon: number },
): Promise<void> {
  const stop = state.open_stop
  if (!stop) return
  const { rows } = await db.query(
    `SELECT id, name, lat, lon FROM destinations
     WHERE status <> 'arrived' AND trip_id IS NOT DISTINCT FROM $1
     ORDER BY order_index, created_at LIMIT 1`,
    [state.trip_id ?? null],
  )
  if (rows.length === 0) return
  const dest = rows[0]
  const distance = haversineMeters(at, { lat: Number(dest.lat), lon: Number(dest.lon) })
  if (distance > cfg.arrival_radius_m) return

  const arrivedAt = stop.started_at // the moment we stopped, not the confirming ping
  const summary = await computeLegSummary(db, state, arrivedAt)
  await db.query('UPDATE stops SET arrival_destination_id = $2 WHERE id = $1', [stop.id, dest.id])
  await db.query(`UPDATE destinations SET status = 'arrived', arrived_at = $2 WHERE id = $1`, [dest.id, arrivedAt])
  await reconcileActiveDestination(db)
  await db.query(
    `INSERT INTO legs (leg_index, destination_id, started_at, arrived_at, summary, trip_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [state.leg_index, dest.id, state.leg_started_at, arrivedAt, JSON.stringify(summary), state.trip_id ?? null],
  )
  await emit('trip.leg.arrived', { destination_id: dest.id, destination_name: dest.name, summary }, arrivedAt)

  state.leg_index += 1
  state.leg_started_at = arrivedAt
  state.leg_miles = 0
  state.leg_states = state.state_code ? [state.state_code] : []
}

async function processPing(
  db: Db,
  cfg: AppConfig,
  state: EngineState,
  trips: TripWindow[],
  ping: PingRow,
  emit: Emit,
): Promise<void> {
  // LOC-001: exactly-once. Seqs already folded into the read model are never reprocessed.
  const seen = await db.query('SELECT 1 FROM pings WHERE seq = $1', [ping.seq])
  if ((seen.rowCount ?? 0) > 0) return

  // LOC-010: a ping older than the newest processed ping joins the breadcrumb in
  // timestamp order but never replays through the stop machine or crossing detection.
  if (state.last_ping && ping.tsMs < Date.parse(state.last_ping.ts)) {
    const hit = stateForPoint(ping.lat, ping.lon)
    await insertPingRow(db, ping, hit?.code ?? null, state.leg_index)
    return
  }

  // TRIP-006: a ping in a different trip window starts a new engine epoch — mileage,
  // states, and leg numbering reset; the state annotation resets so the starting state
  // is checklisted per trip (GEO-003 style); a stop left open by the previous epoch is
  // abandoned (its row keeps the old trip); mileage and stop pairing never span epochs.
  const pingTrip = tripAt(trips, ping.tsMs)
  if (pingTrip !== (state.trip_id ?? null)) {
    state.trip_id = pingTrip
    state.trip_started_at = ping.tsIso
    state.trip_miles = 0
    state.leg_index = await nextLegIndex(db, pingTrip)
    state.leg_started_at = ping.tsIso
    state.leg_miles = 0
    state.leg_states = []
    state.state_code = null
    state.last_ping = null
    state.open_stop = null
  }

  if (!state.trip_started_at) {
    state.trip_started_at = ping.tsIso
    state.leg_started_at = ping.tsIso
  }

  // GEO-001/002/003/005: annotate and emit crossings; misses keep the previous state.
  const hit = stateForPoint(ping.lat, ping.lon)
  if (hit && hit.code !== state.state_code) {
    await emit(
      'location.crossing.state',
      { state: hit.state, state_code: hit.code, prev_state_code: state.state_code },
      ping.tsIso,
    )
    state.state_code = hit.code
    if (!state.leg_states.includes(hit.code)) state.leg_states.push(hit.code)
  }

  // GEO-004: mark the nearest city within city_radius_km visited, once per trip
  // (dedupe is per trip epoch, TRIP-006).
  const city = nearestCityWithin(ping.lat, ping.lon, cfg.city_radius_km)
  if (city) {
    const inserted = await db.query(
      `INSERT INTO cities_visited (city, state_code, first_at, trip_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT ((COALESCE(trip_id, '00000000-0000-0000-0000-000000000000'::uuid)), city, state_code) DO NOTHING`,
      [city.city, city.state_code, ping.tsIso, state.trip_id ?? null],
    )
    if ((inserted.rowCount ?? 0) > 0) {
      await emit('location.crossing.city', { city: city.city, state_code: city.state_code }, ping.tsIso)
    }
  }

  // LOC-007: breadcrumb mileage accumulators (per leg and whole trip).
  if (state.last_ping) {
    const hopMiles = haversineMiles(state.last_ping, ping)
    state.leg_miles += hopMiles
    state.trip_miles += hopMiles
  }

  await insertPingRow(db, ping, state.state_code, state.leg_index)

  // Stop lifecycle via the pure machine (LOC-002..005, LOC-011).
  const machineState: StopMachineState = {
    last: state.last_ping
      ? { lat: state.last_ping.lat, lon: state.last_ping.lon, tsMs: Date.parse(state.last_ping.ts) }
      : null,
    open: state.open_stop
      ? {
          anchorLat: state.open_stop.anchor_lat,
          anchorLon: state.open_stop.anchor_lon,
          startedAtMs: Date.parse(state.open_stop.started_at),
        }
      : null,
  }
  const { effects } = stepStopMachine(machineState, { lat: ping.lat, lon: ping.lon, tsMs: ping.tsMs }, cfg.stop_radius_m)

  for (const effect of effects) {
    if (effect.kind === 'opened') {
      const stopId = randomUUID()
      const startedAtIso = new Date(effect.startedAtMs).toISOString()
      state.open_stop = {
        id: stopId,
        anchor_lat: effect.anchorLat,
        anchor_lon: effect.anchorLon,
        started_at: startedAtIso,
      }
      await db.query(
        `INSERT INTO stops (id, anchor_lat, anchor_lon, started_at, leg_index, trip_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [stopId, effect.anchorLat, effect.anchorLon, startedAtIso, state.leg_index, state.trip_id ?? null],
      )
      // LOC-003: the stop.started event is backdated to the first stationary ping.
      await emit('location.stop.started', { stop_id: stopId, lat: effect.anchorLat, lon: effect.anchorLon }, startedAtIso)
    } else {
      const open = state.open_stop!
      const endedAtIso = ping.tsIso
      const journalWorthy = isJournalWorthy(effect.durationMin, cfg.min_stop_duration_min)
      // GEO-006: journal-worthy stops get the nearest city as their place.
      const place = journalWorthy
        ? (nearestCityWithin(effect.anchorLat, effect.anchorLon, cfg.city_radius_km)?.city ?? null)
        : null
      await db.query(
        `UPDATE stops SET ended_at = $2, duration_min = $3, journal_worthy = $4, place = $5 WHERE id = $1`,
        [open.id, endedAtIso, effect.durationMin, journalWorthy, place],
      )
      await emit(
        'location.stop.ended',
        {
          stop_id: open.id,
          lat: effect.anchorLat,
          lon: effect.anchorLon,
          started_at: open.started_at,
          ended_at: endedAtIso,
          duration_min: effect.durationMin,
          journal_worthy: journalWorthy,
          place,
        },
        endedAtIso,
      )
      state.open_stop = null
    }
  }

  // LOC-006/LOC-012: while stopped, (re-)evaluate arrival every ping against the current
  // position — so a destination reached after the anchor, or made active while already
  // parked, still arrives. A ping that just ended a stop leaves open_stop null and is skipped.
  if (state.open_stop) await checkArrival(db, cfg, state, emit, { lat: ping.lat, lon: ping.lon })

  state.last_ping = { lat: ping.lat, lon: ping.lon, ts: ping.tsIso }
}

/**
 * Entry point called by the sync route with the seqs of newly accepted location.ping
 * events. Processes them in client_ts order (SYNC-005) inside one transaction,
 * serialized by an advisory lock so concurrent flushes cannot interleave.
 */
export async function processNewPings(pool: pg.Pool, bus: EventBus, pingSeqs: number[]): Promise<void> {
  if (pingSeqs.length === 0) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [ENGINE_LOCK_KEY])
    const { rows } = await client.query(
      `SELECT seq, payload, client_ts FROM events
       WHERE seq = ANY($1) AND type = 'location.ping'
       ORDER BY client_ts, seq`,
      [pingSeqs],
    )
    const cfg = await getConfig(client) // CFG-004: fresh thresholds every batch
    const trips = await loadTripWindows(client) // TRIP-006: epoch resolution per batch
    const state = await loadState(client)
    const emit: Emit = async (type, payload, clientTs) => {
      await appendEvent(client, { type, actorId: null, payload, clientTs })
    }
    for (const row of rows) await processPing(client, cfg, state, trips, toPingRow(row), emit)
    await saveState(client, state)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  bus.notify()
}

/**
 * SYS-002: rebuilds every location read model purely from the event stream. Clears
 * pings/stops/cities/legs/engine_state, resets destination arrival status, and replays
 * all location.ping events in client_ts order. Derived events already exist in the
 * append-only stream, so the replay does not re-emit them (SYS-001).
 */
export async function rebuildReadModels(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [ENGINE_LOCK_KEY])
    await client.query('DELETE FROM pings')
    await client.query('DELETE FROM stops')
    await client.query('DELETE FROM cities_visited')
    await client.query('DELETE FROM legs')
    await client.query('DELETE FROM engine_state')
    await client.query(`UPDATE destinations SET status = 'pending', arrived_at = NULL`)
    await reconcileActiveDestination(client)

    const cfg = await getConfig(client)
    const trips = await loadTripWindows(client)
    const state = freshState()
    const noEmit: Emit = async () => {}
    const { rows } = await client.query(
      `SELECT seq, payload, client_ts FROM events WHERE type = 'location.ping' ORDER BY client_ts, seq`,
    )
    for (const row of rows) await processPing(client, cfg, state, trips, toPingRow(row), noEmit)
    await saveState(client, state)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
