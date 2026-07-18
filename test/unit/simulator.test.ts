import { describe, it, expect } from 'vitest'
import { buildScenario, toClientEvents, SCENARIO_NAMES } from '../../scripts/simulate-trip.js'
import { haversineMeters } from '../../src/location/geo.js'

const START = '2026-07-04T12:00:00.000Z'

describe('GPS trip simulator', () => {
  it('exposes the full scenario library', () => {
    expect([...SCENARIO_NAMES].sort()).toEqual(
      [
        'arrival',
        'gas_stop',
        'gps_jitter',
        'lunch_stop',
        'multi_leg_day',
        'normal_drive',
        'state_crossing',
        'traffic_jam',
      ].sort(),
    )
    expect(() => buildScenario('nope' as never)).toThrow()
  })

  it('emits pings along the waypoint path at the configured interval and speed, timestamps compressed by the factor [SIM-001]', () => {
    const plain = buildScenario('normal_drive', { startTime: START, intervalS: 60, compression: 1 })
    expect(plain.pings.length).toBeGreaterThan(10)
    expect(plain.pings[0]!.ts).toBe(START)

    // Interval: consecutive client_ts deltas equal intervalS when compression = 1.
    for (let i = 1; i < plain.pings.length; i++) {
      const dt = Date.parse(plain.pings[i]!.ts) - Date.parse(plain.pings[i - 1]!.ts)
      expect(dt).toBe(60_000)
    }

    // Speed: within the first drive segment, consecutive ping spacing is constant =
    // segment distance / segment duration * interval.
    const spacing = haversineMeters(plain.pings[0]!, plain.pings[1]!)
    expect(spacing).toBeGreaterThan(500) // actually driving
    for (let i = 1; i < 30; i++) {
      const d = haversineMeters(plain.pings[i - 1]!, plain.pings[i]!)
      expect(Math.abs(d - spacing) / spacing).toBeLessThan(0.01)
    }

    // Compression scales timestamps but never the geometry.
    const fast = buildScenario('normal_drive', { startTime: START, intervalS: 60, compression: 60 })
    expect(fast.pings.length).toBe(plain.pings.length)
    for (let i = 1; i < fast.pings.length; i++) {
      const dt = Date.parse(fast.pings[i]!.ts) - Date.parse(fast.pings[i - 1]!.ts)
      expect(dt).toBe(1_000)
    }
    fast.pings.forEach((p, i) => {
      expect(p.lat).toBe(plain.pings[i]!.lat)
      expect(p.lon).toBe(plain.pings[i]!.lon)
    })

    // A different cadence changes the ping count accordingly.
    const sparse = buildScenario('normal_drive', { startTime: START, intervalS: 120 })
    expect(sparse.pings.length).toBe(Math.ceil(plain.pings.length / 2))
  })

  it('applies bounded, seed-deterministic jitter in the gps_jitter scenario [SIM-001] [LOC-011]', () => {
    const clean = buildScenario('gps_jitter', { startTime: START, jitterM: 0 })
    const noisy1 = buildScenario('gps_jitter', { startTime: START, seed: 7 })
    const noisy2 = buildScenario('gps_jitter', { startTime: START, seed: 7 })
    const noisy3 = buildScenario('gps_jitter', { startTime: START, seed: 8 })

    expect(noisy1.pings.length).toBe(clean.pings.length)
    // Bounded: every jittered ping is strictly within 50 m of its true position.
    let maxJitter = 0
    noisy1.pings.forEach((p, i) => {
      const d = haversineMeters(p, clean.pings[i]!)
      maxJitter = Math.max(maxJitter, d)
      expect(d).toBeLessThan(50)
    })
    expect(maxJitter).toBeGreaterThan(5) // noise is actually applied
    // Deterministic per seed.
    expect(noisy1.pings).toEqual(noisy2.pings)
    expect(noisy1.pings).not.toEqual(noisy3.pings)
  })

  it('declares destinations for arrival scenarios', () => {
    expect(buildScenario('arrival').destinations).toHaveLength(1)
    expect(buildScenario('multi_leg_day').destinations).toHaveLength(2)
    expect(buildScenario('normal_drive').destinations).toHaveLength(0)
  })

  it('converts pings to valid sync-batch client events', () => {
    const s = buildScenario('normal_drive', { startTime: START })
    const events = toClientEvents(s.pings)
    expect(events).toHaveLength(s.pings.length)
    const ids = new Set(events.map((e) => e.event_id))
    expect(ids.size).toBe(events.length)
    for (const [i, e] of events.entries()) {
      expect(e.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(e.type).toBe('location.ping')
      expect(e.client_ts).toBe(s.pings[i]!.ts)
      expect(e.payload).toEqual({ lat: s.pings[i]!.lat, lon: s.pings[i]!.lon })
    }
  })
})
