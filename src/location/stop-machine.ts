/**
 * Pure stop-detection state machine (docs/spec/06-location.md).
 *
 * Definitions (normative):
 * - A stationary pair is two consecutive pings within `stop_radius_m` of each other.
 * - A stop opens when the second consecutive ping is within `stop_radius_m` of the
 *   anchor — the FIRST ping of the stationary run (LOC-002) — and is backdated to the
 *   anchor's timestamp (LOC-003).
 * - While open, the stop survives any ping within `stop_radius_m` of the ANCHOR (drift
 *   is measured from the anchor, not the previous ping), which is what makes ±50 m GPS
 *   jitter flap-free (LOC-011).
 * - The first ping farther than `stop_radius_m` from the anchor ends the stop; duration
 *   comes from ping timestamps (LOC-004).
 *
 * Persistence, geocoding, arrival detection, and event emission are layered on top by
 * the engine; this module is deliberately database-free so it unit-tests in isolation.
 */
import { haversineMeters } from './geo.js'

export interface StopPing {
  lat: number
  lon: number
  tsMs: number
}

export interface OpenStop {
  anchorLat: number
  anchorLon: number
  startedAtMs: number
}

export interface StopMachineState {
  /** Most recent processed ping (candidate anchor for the next stationary run). */
  last: StopPing | null
  open: OpenStop | null
}

export type StopEffect =
  | { kind: 'opened'; anchorLat: number; anchorLon: number; startedAtMs: number }
  | {
      kind: 'closed'
      anchorLat: number
      anchorLon: number
      startedAtMs: number
      endedAtMs: number
      durationMin: number
    }

export function initialStopState(): StopMachineState {
  return { last: null, open: null }
}

/** LOC-005: a stop is journal-worthy when it lasted at least `min_stop_duration_min`. */
export function isJournalWorthy(durationMin: number, minStopDurationMin: number): boolean {
  return durationMin >= minStopDurationMin
}

/**
 * Advances the machine by one ping. Returns the next state and any lifecycle effects.
 * Note: the ping that ends a stop becomes the candidate anchor of the next run, but is
 * never paired with the last in-stop ping (that pair spans the departure).
 */
export function stepStopMachine(
  state: StopMachineState,
  ping: StopPing,
  stopRadiusM: number,
): { state: StopMachineState; effects: StopEffect[] } {
  const effects: StopEffect[] = []
  let open = state.open

  if (open) {
    const drift = haversineMeters({ lat: open.anchorLat, lon: open.anchorLon }, ping)
    if (drift > stopRadiusM) {
      effects.push({
        kind: 'closed',
        anchorLat: open.anchorLat,
        anchorLon: open.anchorLon,
        startedAtMs: open.startedAtMs,
        endedAtMs: ping.tsMs,
        durationMin: (ping.tsMs - open.startedAtMs) / 60_000,
      })
      open = null
    }
  } else if (state.last) {
    const hop = haversineMeters(state.last, ping)
    if (hop <= stopRadiusM) {
      open = { anchorLat: state.last.lat, anchorLon: state.last.lon, startedAtMs: state.last.tsMs }
      effects.push({
        kind: 'opened',
        anchorLat: open.anchorLat,
        anchorLon: open.anchorLon,
        startedAtMs: open.startedAtMs,
      })
    }
  }

  return { state: { last: ping, open }, effects }
}
