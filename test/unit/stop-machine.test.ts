import { describe, it, expect } from 'vitest'
import {
  initialStopState,
  stepStopMachine,
  isJournalWorthy,
  type StopEffect,
  type StopPing,
  type StopMachineState,
} from '../../src/location/stop-machine.js'
import { offsetMeters } from '../../src/location/geo.js'

const BASE = { lat: 40.16, lon: -105.06 }
const T0 = Date.parse('2026-07-01T08:00:00Z')
const min = (m: number) => T0 + m * 60_000

function ping(northM: number, atMin: number, eastM = 0): StopPing {
  const p = offsetMeters(BASE, northM, eastM)
  return { lat: p.lat, lon: p.lon, tsMs: min(atMin) }
}

function run(pings: StopPing[], stopRadiusM = 100): { state: StopMachineState; effects: StopEffect[] } {
  let state = initialStopState()
  const effects: StopEffect[] = []
  for (const p of pings) {
    const r = stepStopMachine(state, p, stopRadiusM)
    state = r.state
    effects.push(...r.effects)
  }
  return { state, effects }
}

describe('stop detection state machine', () => {
  it('opens a stop when the second consecutive ping is within stop_radius_m, anchored at the first ping of the run [LOC-002]', () => {
    const p1 = ping(0, 0)
    const p2 = ping(3000, 2)
    const p3 = ping(3000, 4) // 0 m from p2 -> stationary pair
    const { state, effects } = run([p1, p2, p3])
    expect(effects).toHaveLength(1)
    const opened = effects[0]!
    expect(opened.kind).toBe('opened')
    if (opened.kind !== 'opened') throw new Error('unreachable')
    expect(opened.anchorLat).toBeCloseTo(p2.lat, 10)
    expect(opened.anchorLon).toBeCloseTo(p2.lon, 10)
    expect(state.open).not.toBeNull()
  })

  it('backdates the stop start to the first stationary ping timestamp [LOC-003]', () => {
    const { effects } = run([ping(0, 0), ping(3000, 7), ping(3040, 9)])
    const opened = effects[0]!
    if (opened.kind !== 'opened') throw new Error('expected opened effect')
    expect(opened.startedAtMs).toBe(min(7)) // the anchor ping, not the confirming ping
  })

  it('does not open a stop for consecutive pings farther apart than stop_radius_m [LOC-002]', () => {
    const { state, effects } = run([ping(0, 0), ping(150, 2), ping(300, 4)])
    expect(effects).toHaveLength(0)
    expect(state.open).toBeNull()
  })

  it('treats a pair at the stop_radius_m boundary as stationary (<= opens, only > ends) [LOC-002] [LOC-004]', () => {
    // Open with a pair just inside 100 m.
    const { effects } = run([ping(0, 0), ping(99.9, 2)])
    expect(effects.map((e) => e.kind)).toEqual(['opened'])
  })

  it('ends the stop at the first ping farther than stop_radius_m from the anchor, with duration from ping timestamps [LOC-004]', () => {
    const { state, effects } = run([
      ping(0, 0),
      ping(0, 4), // opens, anchor ts = min 0
      ping(60, 8), // 60 m from anchor: still stationary
      ping(90, 12), // 90 m from anchor: still stationary (drift measured from anchor, not last ping)
      ping(3000, 18), // ends it
    ])
    expect(effects.map((e) => e.kind)).toEqual(['opened', 'closed'])
    const closed = effects[1]!
    if (closed.kind !== 'closed') throw new Error('expected closed effect')
    expect(closed.startedAtMs).toBe(min(0))
    expect(closed.endedAtMs).toBe(min(18))
    expect(closed.durationMin).toBeCloseTo(18, 9)
    expect(state.open).toBeNull()
  })

  it('flags journal-worthiness by min_stop_duration_min [LOC-005]', () => {
    expect(isJournalWorthy(9.99, 10)).toBe(false)
    expect(isJournalWorthy(10, 10)).toBe(true)
    expect(isJournalWorthy(45, 10)).toBe(true)
    expect(isJournalWorthy(4, 3)).toBe(true)
  })

  it('a 15-minute stop with deterministic ±50 m jitter yields exactly one stop, no flapping [LOC-011]', () => {
    // Drive up, then 15 minutes of jittered pings around BASE (radius <= 50 m), then drive away.
    // Includes worst-case opposite offsets (100 m apart pair-wise but always <= 100 m from any anchor).
    const jitterOffsets: Array<[number, number]> = [
      [49, 0],
      [-49, 0],
      [0, 49],
      [0, -49],
      [34, 34],
      [-34, -34],
      [-34, 34],
      [34, -34],
      [10, -20],
      [0, 0],
      [25, 25],
      [-49, 0],
      [49, 0],
      [0, 0],
      [-20, 30],
      [15, -15],
    ]
    const pings: StopPing[] = [ping(-3000, -2)]
    jitterOffsets.forEach(([n, e], i) => pings.push(ping(n, i, e)))
    pings.push(ping(4000, 16))
    const { effects } = run(pings)
    expect(effects.map((e) => e.kind)).toEqual(['opened', 'closed'])
    const closed = effects[1]!
    if (closed.kind !== 'closed') throw new Error('expected closed effect')
    expect(closed.durationMin).toBeGreaterThanOrEqual(15)
  })

  it('can start a new stationary run on the ping that ended the previous stop [LOC-004]', () => {
    const { effects } = run([
      ping(0, 0),
      ping(0, 5), // opens stop A anchored min 0
      ping(3000, 10), // closes stop A; becomes candidate anchor
      ping(3010, 12), // within radius of previous ping -> opens stop B anchored min 10
      ping(9000, 20), // closes stop B
    ])
    expect(effects.map((e) => e.kind)).toEqual(['opened', 'closed', 'opened', 'closed'])
    const openedB = effects[2]!
    if (openedB.kind !== 'opened') throw new Error('expected opened effect')
    expect(openedB.startedAtMs).toBe(min(10))
  })

  it('does not pair the last in-stop ping with the ending ping to reopen immediately [LOC-004]', () => {
    const { state, effects } = run([
      ping(0, 0),
      ping(10, 5), // opens
      ping(150, 10), // ends (150 m > radius from anchor)
    ])
    expect(effects.map((e) => e.kind)).toEqual(['opened', 'closed'])
    // Even though the ending ping is within 140 m of the last in-stop ping, no new stop opened.
    expect(state.open).toBeNull()
  })
})
