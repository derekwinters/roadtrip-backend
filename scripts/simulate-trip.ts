#!/usr/bin/env tsx
/**
 * GPS trip simulator (docs/spec/10-testing.md, SIM-001..006).
 *
 * Library: `buildScenario(name, opts)` turns a named preset (waypoints + per-segment
 * durations + stops) into a `location.ping` trail: waypoint interpolation at segment
 * speed, configurable ping interval, start time, time compression (client_ts deltas are
 * divided by the factor — a 12-hour drive can span seconds; the server never sleeps on
 * client_ts), and optional seeded ±jitter.
 *
 * CLI: posts a scenario to a running server through the public sync API in chunks.
 *
 *   npm run simulate -- --scenario gas_stop --profile <parent-uuid> [--url http://localhost:8080]
 *                       [--compression 60] [--interval 60] [--seed 42] [--start <ISO>]
 *
 * All scenario routes use real US coordinates (I-25 corridor, Denver → Wyoming), so the
 * bundled state polygons and city list geocode them exactly like a real drive.
 */
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { offsetMeters, type LatLon } from '../src/location/geo.js'

// ---------------------------------------------------------------------------
// Scenario library
// ---------------------------------------------------------------------------

export const SCENARIO_NAMES = [
  'normal_drive',
  'gas_stop',
  'lunch_stop',
  'traffic_jam',
  'gps_jitter',
  'state_crossing',
  'arrival',
  'multi_leg_day',
] as const

export type ScenarioName = (typeof SCENARIO_NAMES)[number]

export interface SimOptions {
  /** Ping cadence in simulated trip seconds (default 60). */
  intervalS?: number
  /** Divide client_ts deltas by this factor (default 1 = real-time timestamps). */
  compression?: number
  /** ISO client_ts of the first ping (default a fixed date, for reproducibility). */
  startTime?: string
  /** Max GPS noise radius in meters (overrides the scenario default). */
  jitterM?: number
  /** PRNG seed for jitter (default 42). */
  seed?: number
}

export interface SimPing {
  lat: number
  lon: number
  ts: string
}

export interface SimDestination {
  name: string
  lat: number
  lon: number
}

export interface Scenario {
  name: ScenarioName
  pings: SimPing[]
  /** Destinations the trip should have configured before syncing (arrival scenarios). */
  destinations: SimDestination[]
  intervalS: number
  compression: number
  startTime: string
}

type Phase =
  | { kind: 'drive'; from: LatLon; to: LatLon; durationS: number }
  | { kind: 'stop'; at: LatLon; durationS: number }

interface ScenarioDef {
  phases: Phase[]
  destinations: SimDestination[]
  defaultJitterM: number
}

// Real I-25 corridor waypoints (verified against data/us-states.geojson polygons).
const DENVER: LatLon = { lat: 39.7392, lon: -104.9903 }
const LOVELAND_I25: LatLon = { lat: 40.4, lon: -104.99 }
const FORT_COLLINS: LatLon = { lat: 40.5853, lon: -105.0844 }
const CO_BORDER_APPROACH: LatLon = { lat: 40.95, lon: -104.95 } // still Colorado
const CHEYENNE: LatLon = { lat: 41.14, lon: -104.8202 } // Wyoming
const CHUGWATER: LatLon = { lat: 41.75, lon: -104.82 }
const WHEATLAND: LatLon = { lat: 42.05, lon: -104.95 }
const NORTH_OF_WHEATLAND: LatLon = { lat: 42.3, lon: -104.97 }
// A 20-minute crawl covering ~80 m: "slow pings in place" (SIM-006 accepted quirk).
const JAM_END = offsetMeters(LOVELAND_I25, 80, 0)

const drive = (from: LatLon, to: LatLon, durationS: number): Phase => ({ kind: 'drive', from, to, durationS })
const stop = (at: LatLon, durationS: number): Phase => ({ kind: 'stop', at, durationS })

const SCENARIOS: Record<ScenarioName, ScenarioDef> = {
  normal_drive: {
    phases: [drive(DENVER, LOVELAND_I25, 3600), drive(LOVELAND_I25, FORT_COLLINS, 1800)],
    destinations: [],
    defaultJitterM: 0,
  },
  gas_stop: {
    phases: [drive(DENVER, LOVELAND_I25, 3600), stop(LOVELAND_I25, 900), drive(LOVELAND_I25, FORT_COLLINS, 1800)],
    destinations: [],
    defaultJitterM: 0,
  },
  lunch_stop: {
    phases: [drive(DENVER, LOVELAND_I25, 3600), stop(LOVELAND_I25, 2700), drive(LOVELAND_I25, FORT_COLLINS, 1800)],
    destinations: [],
    defaultJitterM: 0,
  },
  traffic_jam: {
    phases: [
      drive(DENVER, LOVELAND_I25, 3600),
      drive(LOVELAND_I25, JAM_END, 1200), // the jam
      drive(JAM_END, FORT_COLLINS, 1800),
    ],
    destinations: [],
    defaultJitterM: 0,
  },
  gps_jitter: {
    phases: [drive(DENVER, LOVELAND_I25, 3600), stop(LOVELAND_I25, 900), drive(LOVELAND_I25, FORT_COLLINS, 1800)],
    destinations: [],
    defaultJitterM: 50,
  },
  state_crossing: {
    phases: [drive(DENVER, CO_BORDER_APPROACH, 4800), drive(CO_BORDER_APPROACH, CHEYENNE, 1500)],
    destinations: [],
    defaultJitterM: 0,
  },
  arrival: {
    phases: [
      drive(DENVER, LOVELAND_I25, 3600),
      stop(LOVELAND_I25, 900), // en-route gas stop
      drive(LOVELAND_I25, FORT_COLLINS, 1800),
      stop(FORT_COLLINS, 1200), // arrive and stay
    ],
    destinations: [{ name: 'Fort Collins', ...FORT_COLLINS }],
    defaultJitterM: 0,
  },
  multi_leg_day: {
    phases: [
      drive(DENVER, CO_BORDER_APPROACH, 4800),
      drive(CO_BORDER_APPROACH, CHEYENNE, 1500),
      stop(CHEYENNE, 2700), // lunch at destination 1
      drive(CHEYENNE, CHUGWATER, 3600),
      stop(CHUGWATER, 900), // gas stop
      drive(CHUGWATER, WHEATLAND, 1800),
      stop(WHEATLAND, 1200), // destination 2 layover
      drive(WHEATLAND, NORTH_OF_WHEATLAND, 1500), // in-progress leg
    ],
    destinations: [
      { name: 'Cheyenne', ...CHEYENNE },
      { name: 'Wheatland', ...WHEATLAND },
    ],
    defaultJitterM: 0,
  },
}

/** Deterministic PRNG (mulberry32) so jitter scenarios are reproducible per seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function positionAt(phases: Phase[], tS: number): LatLon {
  let acc = 0
  for (const phase of phases) {
    if (tS < acc + phase.durationS) {
      if (phase.kind === 'stop') return phase.at
      const frac = (tS - acc) / phase.durationS
      return {
        lat: phase.from.lat + (phase.to.lat - phase.from.lat) * frac,
        lon: phase.from.lon + (phase.to.lon - phase.from.lon) * frac,
      }
    }
    acc += phase.durationS
  }
  const last = phases[phases.length - 1]!
  return last.kind === 'stop' ? last.at : last.to
}

/**
 * SIM-001: pings along the waypoint path at the configured interval and segment speed,
 * client_ts compressed by the given factor, optional bounded jitter (< jitterM meters).
 */
export function buildScenario(name: ScenarioName, opts: SimOptions = {}): Scenario {
  const def = SCENARIOS[name]
  if (!def) throw new Error(`Unknown scenario: ${name}. Known: ${SCENARIO_NAMES.join(', ')}`)
  const intervalS = opts.intervalS ?? 60
  const compression = opts.compression ?? 1
  const startTime = opts.startTime ?? '2026-07-04T12:00:00.000Z'
  const jitterM = opts.jitterM ?? def.defaultJitterM
  const rand = mulberry32(opts.seed ?? 42)

  const totalS = def.phases.reduce((sum, p) => sum + p.durationS, 0)
  const startMs = Date.parse(startTime)
  if (Number.isNaN(startMs)) throw new Error(`Invalid startTime: ${startTime}`)

  const pings: SimPing[] = []
  for (let tS = 0; tS <= totalS; tS += intervalS) {
    let pos = positionAt(def.phases, tS)
    if (jitterM > 0) {
      // Uniform on a disc of radius < jitterM: never pushes two samples of the same
      // true point more than 2*jitterM apart (what keeps LOC-011 flap-free).
      const r = jitterM * Math.sqrt(rand())
      const theta = 2 * Math.PI * rand()
      pos = offsetMeters(pos, r * Math.cos(theta), r * Math.sin(theta))
    }
    pings.push({ lat: pos.lat, lon: pos.lon, ts: new Date(startMs + (tS / compression) * 1000).toISOString() })
  }

  return { name, pings, destinations: [...def.destinations], intervalS, compression, startTime }
}

/** Wraps pings as sync-batch client events (each with its own idempotency UUID). */
export function toClientEvents(
  pings: SimPing[],
): Array<{ event_id: string; type: 'location.ping'; client_ts: string; payload: { lat: number; lon: number } }> {
  return pings.map((p) => ({
    event_id: randomUUID(),
    type: 'location.ping' as const,
    client_ts: p.ts,
    payload: { lat: p.lat, lon: p.lon },
  }))
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliDeps {
  fetchImpl: typeof fetch
  log: (line: string) => void
}

export async function runCli(argv: string[], deps: CliDeps = { fetchImpl: fetch, log: console.log }): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string', default: 'http://localhost:8080' },
      scenario: { type: 'string' },
      profile: { type: 'string' },
      compression: { type: 'string', default: '1' },
      interval: { type: 'string' },
      seed: { type: 'string' },
      start: { type: 'string' },
      'chunk-size': { type: 'string', default: '200' },
    },
  })

  if (!values.scenario || !SCENARIO_NAMES.includes(values.scenario as ScenarioName)) {
    throw new Error(`--scenario is required (one of: ${SCENARIO_NAMES.join(', ')})`)
  }
  if (!values.profile) {
    throw new Error('--profile is required (a parent profile UUID; pings are parent-only)')
  }

  const scenario = buildScenario(values.scenario as ScenarioName, {
    compression: Number(values.compression),
    intervalS: values.interval ? Number(values.interval) : undefined,
    seed: values.seed ? Number(values.seed) : undefined,
    startTime: values.start,
  })
  const base = values.url!.replace(/\/$/, '')
  const headers = { 'content-type': 'application/json', 'x-profile-id': values.profile }

  for (const dest of scenario.destinations) {
    const res = await deps.fetchImpl(`${base}/api/destinations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(dest),
    })
    if (!res.ok) throw new Error(`Failed to create destination ${dest.name}: HTTP ${res.status}`)
    deps.log(`destination created: ${dest.name}`)
  }

  const events = toClientEvents(scenario.pings)
  const chunkSize = Math.max(1, Math.min(500, Number(values['chunk-size'])))
  const tally = { accepted: 0, duplicate: 0, rejected: 0 }
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize)
    const res = await deps.fetchImpl(`${base}/api/sync/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ device_id: 'simulator', events: chunk }),
    })
    if (!res.ok) throw new Error(`sync batch failed: HTTP ${res.status} ${await res.text()}`)
    const body = (await res.json()) as { results: Array<{ status: 'accepted' | 'duplicate' | 'rejected' }> }
    for (const r of body.results) tally[r.status] += 1
    deps.log(`batch ${Math.floor(i / chunkSize) + 1}: ${chunk.length} events sent`)
  }
  deps.log(
    `scenario ${scenario.name}: ${events.length} pings — accepted ${tally.accepted}, ` +
      `duplicate ${tally.duplicate}, rejected ${tally.rejected}`,
  )
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
