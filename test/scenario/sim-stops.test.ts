import { describe, it, expect, afterAll } from 'vitest'
import { buildScenario } from '../../scripts/simulate-trip.js'
import {
  setupScenario,
  runPings,
  eventsOfType,
  getJson,
  findStationaryRun,
  minutesBetween,
  type ScenarioHarness,
} from './support.js'

const START = '2026-07-04T13:00:00.000Z'
const opened: ScenarioHarness[] = []
afterAll(async () => {
  for (const h of opened) await h.t.close()
})

describe('simulated stop scenarios (through the real API)', () => {
  it('gas_stop yields exactly one journal-worthy stop with backdated start and correct duration [SIM-002]', async () => {
    const scenario = buildScenario('gas_stop', { startTime: START })
    const h = await setupScenario(scenario)
    opened.push(h)
    await runPings(h, scenario.pings)

    const run = findStationaryRun(scenario.pings)
    const expectedStart = scenario.pings[run.start]!.ts
    const expectedEnd = scenario.pings[run.endAfter]!.ts

    const started = await eventsOfType(h, 'location.stop.started')
    const ended = await eventsOfType(h, 'location.stop.ended')
    expect(started).toHaveLength(1)
    expect(ended).toHaveLength(1)
    expect(started[0]!.client_ts).toBe(expectedStart) // backdated to the first stationary ping
    expect(ended[0]!.payload).toMatchObject({
      started_at: expectedStart,
      ended_at: expectedEnd,
      journal_worthy: true,
    })
    expect(ended[0]!.payload.duration_min).toBeCloseTo(minutesBetween(expectedStart, expectedEnd), 6)
    expect(ended[0]!.payload.duration_min).toBeGreaterThanOrEqual(15)

    const checklist = await getJson(h, '/api/checklist')
    expect(checklist.stops).toHaveLength(1)
  })

  it('lunch_stop yields one 45+ minute journal-worthy stop [SIM-002]', async () => {
    const scenario = buildScenario('lunch_stop', { startTime: START })
    const h = await setupScenario(scenario)
    opened.push(h)
    await runPings(h, scenario.pings)

    const ended = await eventsOfType(h, 'location.stop.ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]!.payload.journal_worthy).toBe(true)
    expect(ended[0]!.payload.duration_min).toBeGreaterThanOrEqual(45)
  })

  it('traffic_jam registers a single stop — the documented accepted quirk [SIM-006]', async () => {
    const scenario = buildScenario('traffic_jam', { startTime: START })
    const h = await setupScenario(scenario)
    opened.push(h)
    await runPings(h, scenario.pings)

    const run = findStationaryRun(scenario.pings)
    const started = await eventsOfType(h, 'location.stop.started')
    const ended = await eventsOfType(h, 'location.stop.ended')
    expect(started).toHaveLength(1) // the whole crawl is one stop, no flapping
    expect(ended).toHaveLength(1)
    expect(started[0]!.client_ts).toBe(scenario.pings[run.start]!.ts)
    expect(ended[0]!.payload.journal_worthy).toBe(true) // a 20-minute jam is journal-worthy
    expect(ended[0]!.payload.duration_min).toBeGreaterThanOrEqual(20)
  })

  it('gps_jitter keeps a 15-minute stop detected as exactly one stop despite ±50 m noise [SIM-003] [LOC-011]', async () => {
    const scenario = buildScenario('gps_jitter', { startTime: START, seed: 1234 })
    const h = await setupScenario(scenario)
    opened.push(h)
    await runPings(h, scenario.pings)

    const started = await eventsOfType(h, 'location.stop.started')
    const ended = await eventsOfType(h, 'location.stop.ended')
    expect(started).toHaveLength(1)
    expect(ended).toHaveLength(1)
    expect(ended[0]!.payload.journal_worthy).toBe(true)
    expect(ended[0]!.payload.duration_min).toBeGreaterThanOrEqual(14)
    expect(ended[0]!.payload.duration_min).toBeLessThanOrEqual(18)
  })
})
