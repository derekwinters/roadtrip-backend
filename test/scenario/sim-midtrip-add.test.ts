import { describe, it, expect, afterAll } from 'vitest'
import { buildScenario } from '../../scripts/simulate-trip.js'
import { haversineMeters } from '../../src/location/geo.js'
import { createTestApp, asProfile } from '../helpers/app.js'
import { runPings, getJson, findStationaryRun, type ScenarioHarness } from './support.js'

const START = '2026-07-05T12:00:00.000Z'

const opened: ScenarioHarness[] = []
afterAll(async () => {
  for (const h of opened) await h.t.close()
})

/**
 * Regression guard for issue #134 (roadtrip-android): a parent arrives at destination A, then
 * a couple of hours later adds destination B and departs. The reported bug was purely client-
 * side (the app never re-pulled the server read models after the add/arrival). This test pins
 * that the BACKEND engine is correct for the exact sequence — create only A, arrive at A, POST
 * B while parked at A with the arrival stop still open, then depart, drive, and arrive at B —
 * and that `/api/legs` reports two legs (leg 0 -> A, leg 1 -> B) with both destinations arrived.
 */
describe('mid-trip destination add (through the real API)', () => {
  it('adding destination B while parked at A yields a second leg to B [LOC-006]', async () => {
    const scenario = buildScenario('multi_leg_day', { startTime: START })
    expect(scenario.destinations).toHaveLength(2)
    const destA = scenario.destinations[0]! // Cheyenne
    const destB = scenario.destinations[1]! // Wheatland

    const t = await createTestApp()
    const parent = await t.addProfile('Dad', 'parent')

    // Only destination A exists when the trip starts; B is added later, mid-trip.
    const createA = await t.app.inject({
      method: 'POST',
      url: '/api/destinations',
      headers: asProfile(parent.id),
      payload: { name: destA.name, lat: destA.lat, lon: destA.lon },
    })
    expect(createA.statusCode).toBe(201)
    const rowA = createA.json()
    expect(rowA.status).toBe('active') // the only destination is the active one

    const h: ScenarioHarness = { t, parent, destinations: [rowA] }
    opened.push(h)

    // Split the ping stream a few pings after arrival at A. The lunch stop at Cheyenne is the
    // first stationary run; the stop (and thus the arrival) opens on its second ping, so a few
    // pings past the run's start guarantees A has arrived before B is posted.
    const arrivalRun = findStationaryRun(scenario.pings)
    const split = arrivalRun.start + 4
    const beforeAdd = scenario.pings.slice(0, split)
    const afterAdd = scenario.pings.slice(split)

    await runPings(h, beforeAdd)

    // A has arrived: exactly one leg (leg 0 -> A) and A is the only destination, now 'arrived'.
    // This is the "parked at A with the arrival stop open" state in which the parent adds B.
    const legsAfterA = await getJson(h, '/api/legs')
    expect(legsAfterA).toHaveLength(1)
    expect(legsAfterA[0].destination_id).toBe(rowA.id)
    expect(legsAfterA[0].leg_index).toBe(0)
    const destsAfterA = await getJson(h, '/api/destinations')
    expect(destsAfterA.find((d: any) => d.id === rowA.id).status).toBe('arrived')

    // Parent adds destination B from the map while still parked at A.
    const createB = await t.app.inject({
      method: 'POST',
      url: '/api/destinations',
      headers: asProfile(parent.id),
      payload: { name: destB.name, lat: destB.lat, lon: destB.lon },
    })
    expect(createB.statusCode).toBe(201)
    const rowB = createB.json()
    // B immediately becomes the active destination (A is arrived): this is exactly the server
    // state the buggy client failed to re-pull.
    expect(rowB.status).toBe('active')

    // Depart A, drive to B, and arrive.
    await runPings(h, afterAdd)

    // Two legs now, in order: leg 0 -> A, leg 1 -> B.
    const legs = await getJson(h, '/api/legs')
    expect(legs).toHaveLength(2)
    expect(legs[0].destination_id).toBe(rowA.id)
    expect(legs[1].destination_id).toBe(rowB.id)
    expect(legs[0].leg_index).toBe(0)
    expect(legs[1].leg_index).toBe(1)
    // Each arrival is backdated to the stationary anchor at that destination (LOC-003/006).
    const arrivalATs = scenario.pings.find((p) => haversineMeters(p, destA) < 1)!.ts
    const arrivalBTs = scenario.pings.find((p) => haversineMeters(p, destB) < 1)!.ts
    expect(legs[0].arrived_at).toBe(arrivalATs)
    expect(legs[1].arrived_at).toBe(arrivalBTs)
    expect(legs[1].started_at).toBe(arrivalATs) // leg 1 begins exactly at the arrival at A

    // Both destinations end 'arrived' and the active destination is cleared.
    const dests = await getJson(h, '/api/destinations')
    expect(dests.find((d: any) => d.id === rowA.id).status).toBe('arrived')
    expect(dests.find((d: any) => d.id === rowB.id).status).toBe('arrived')
    expect(dests.some((d: any) => d.status === 'active')).toBe(false)
  })
})
