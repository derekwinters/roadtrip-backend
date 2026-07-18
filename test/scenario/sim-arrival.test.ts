import { describe, it, expect, afterAll } from 'vitest'
import { buildScenario } from '../../scripts/simulate-trip.js'
import { pathMiles, haversineMeters } from '../../src/location/geo.js'
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

describe('simulated arrival (through the real API)', () => {
  it('arrival triggers detection and a leg summary matching the scenario reference values [SIM-005] [LOC-007]', async () => {
    const scenario = buildScenario('arrival', { startTime: START })
    expect(scenario.destinations).toHaveLength(1)
    const dest = scenario.destinations[0]!
    const h = await setupScenario(scenario)
    opened.push(h)
    await runPings(h, scenario.pings)

    // Reference values computed straight from the generated pings.
    const arrivalIndex = scenario.pings.findIndex((p) => haversineMeters(p, dest) < 1)
    expect(arrivalIndex).toBeGreaterThan(0)
    const arrivalTs = scenario.pings[arrivalIndex]!.ts
    const referenceMiles = pathMiles(scenario.pings.slice(0, arrivalIndex + 1))
    const referenceWall = minutesBetween(scenario.pings[0]!.ts, arrivalTs)
    const gasRun = findStationaryRun(scenario.pings)
    expect(gasRun.start).toBeLessThan(arrivalIndex) // the gas stop happens en route
    const gasMinutes = minutesBetween(scenario.pings[gasRun.start]!.ts, scenario.pings[gasRun.endAfter]!.ts)

    const arrived = await eventsOfType(h, 'trip.leg.arrived')
    expect(arrived).toHaveLength(1)
    expect(arrived[0]!.payload.destination_id).toBe(h.destinations[0].id)
    expect(arrived[0]!.client_ts).toBe(arrivalTs)

    const dests = await getJson(h, '/api/destinations')
    expect(dests[0]).toMatchObject({ status: 'arrived' })
    expect(new Date(dests[0].arrived_at).toISOString()).toBe(arrivalTs)

    const leg = await getJson(h, `/api/legs/${h.destinations[0].id}`)
    expect(leg.leg_index).toBe(0)
    expect(leg.started_at).toBe(scenario.pings[0]!.ts)
    expect(leg.arrived_at).toBe(arrivalTs)

    // Mileage within 0.5% of the haversine reference (LOC-007).
    expect(Math.abs(leg.summary.miles - referenceMiles) / referenceMiles).toBeLessThan(0.005)
    expect(leg.summary.wall_minutes).toBeCloseTo(referenceWall, 6)
    expect(leg.summary.stop_count).toBe(1)
    expect(leg.summary.moving_minutes).toBeCloseTo(referenceWall - gasMinutes, 6)
    expect(leg.summary.states).toEqual(['CO'])
    expect(leg.summary.games_played).toBe(0)

    // The arrival event carries the same summary payload (LOC-009 shape end-to-end).
    expect(arrived[0]!.payload.summary).toEqual(leg.summary)
  })
})
