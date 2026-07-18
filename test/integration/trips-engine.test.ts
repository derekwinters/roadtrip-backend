import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { pathMiles, type LatLon } from '../../src/location/geo.js'
import { rebuildReadModels } from '../../src/location/engine.js'

const DENVER: LatLon = { lat: 39.7392, lon: -104.9903 }
const LOVELAND: LatLon = { lat: 40.4, lon: -104.99 }
const FORT_COLLINS: LatLon = { lat: 40.5853, lon: -105.0844 }
const CHEYENNE: LatLon = { lat: 41.14, lon: -104.8202 }

/**
 * Trip epochs use live client timestamps: every synced ping is stamped "now", so each
 * ping falls inside whatever trip window is open at that moment (or none). Positions can
 * jump arbitrarily — the engine has no speed limit — which keeps the test fast while the
 * stationary-pair and arrival logic behave exactly as on a real drive.
 */
describe('location engine trip epochs', () => {
  let t: TestApp
  let parent: { id: string }
  let tripA: any
  let tripB: any
  const aTrail: LatLon[] = []
  const bTrail: LatLon[] = []

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
  })
  afterAll(async () => await t.close())

  async function syncPingNow(pt: LatLon) {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(parent.id),
      payload: {
        device_id: 'epoch-test',
        events: [
          {
            event_id: randomUUID(),
            type: 'location.ping',
            client_ts: new Date().toISOString(),
            payload: { lat: pt.lat, lon: pt.lon },
          },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().results[0].status).toBe('accepted')
  }

  const addDest = async (name: string, pt: LatLon) => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/destinations',
      headers: asProfile(parent.id),
      payload: { name, lat: pt.lat, lon: pt.lon },
    })
    expect(res.statusCode).toBe(201)
    return res.json()
  }

  const getJson = async (url: string) => {
    const res = await t.app.inject({ method: 'GET', url, headers: asProfile(parent.id) })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  const engineData = async () => (await t.db.pool.query('SELECT data FROM engine_state WHERE id = 1')).rows[0].data

  it('starting a trip resets the engine epoch; legs, stops, and cities are recorded per trip [TRIP-006]', async () => {
    tripA = (
      await t.app.inject({ method: 'POST', url: '/api/trips', headers: asProfile(parent.id), payload: { name: 'Trip A' } })
    ).json()
    await addDest('Loveland', LOVELAND)

    for (const pt of [DENVER, LOVELAND, LOVELAND]) {
      aTrail.push(pt)
      await syncPingNow(pt)
    }

    // Trip A: starting-state crossing, city, one arrival at leg 0 — all tagged with A.
    let crossings = (await getJson('/api/events?types=location.crossing.state')).events
    expect(crossings).toHaveLength(1)
    expect(crossings[0].payload.state_code).toBe('CO')
    expect(crossings[0].trip_id).toBe(tripA.id)

    let legs = (await t.db.pool.query('SELECT leg_index, trip_id FROM legs ORDER BY started_at')).rows
    expect(legs).toEqual([{ leg_index: 0, trip_id: tripA.id }])
    expect((await engineData()).trip_id).toBe(tripA.id)

    await t.app.inject({ method: 'POST', url: `/api/trips/${tripA.id}/end`, headers: asProfile(parent.id) })

    // Between trips the tracker keeps working, unassociated (TRIP-010).
    await syncPingNow(FORT_COLLINS)
    crossings = (await getJson('/api/events?types=location.crossing.state')).events
    expect(crossings).toHaveLength(2) // NULL epoch re-checklists the starting state
    expect(crossings[1].trip_id).toBeNull()
    expect((await engineData()).trip_id).toBeNull()

    // Trip B: fresh epoch — leg numbering restarts at 0 and cities re-collect per trip.
    tripB = (
      await t.app.inject({ method: 'POST', url: '/api/trips', headers: asProfile(parent.id), payload: { name: 'Trip B' } })
    ).json()
    await addDest('Cheyenne', CHEYENNE)
    for (const pt of [DENVER, CHEYENNE, CHEYENNE]) {
      bTrail.push(pt)
      await syncPingNow(pt)
    }

    crossings = (await getJson('/api/events?types=location.crossing.state')).events
    expect(crossings.map((c: any) => [c.payload.state_code, c.trip_id])).toEqual([
      ['CO', tripA.id],
      ['CO', null],
      ['CO', tripB.id],
      ['WY', tripB.id],
    ])

    legs = (await t.db.pool.query('SELECT leg_index, trip_id FROM legs ORDER BY started_at')).rows
    expect(legs).toEqual([
      { leg_index: 0, trip_id: tripA.id },
      { leg_index: 0, trip_id: tripB.id }, // reset, not continued from trip A
    ])

    const cities = (await t.db.pool.query('SELECT city, trip_id FROM cities_visited')).rows
    expect(cities.map((c: any) => `${c.city}@${c.trip_id ?? 'none'}`).sort()).toEqual(
      [
        `Denver@${tripA.id}`,
        `Loveland@${tripA.id}`,
        'Fort Collins@none',
        `Denver@${tripB.id}`, // once per trip, so Denver collects again
        `Cheyenne@${tripB.id}`,
      ].sort(),
    )

    const stops = (await t.db.pool.query('SELECT trip_id FROM stops ORDER BY started_at')).rows
    expect(stops.map((s: any) => s.trip_id)).toEqual([tripA.id, tripB.id])
    expect((await engineData()).trip_id).toBe(tripB.id)
  })

  it('map, legs, and checklist scope per trip and default to the active trip [TRIP-007]', async () => {
    const mapA = await getJson(`/api/map?trip=${tripA.id}`)
    expect(mapA.breadcrumb).toHaveLength(3) // excludes the between-trips ping and trip B
    expect(mapA.current.lat).toBeCloseTo(LOVELAND.lat, 8)
    const mapB = await getJson(`/api/map?trip=${tripB.id}`)
    expect(mapB.breadcrumb).toHaveLength(3)
    expect(mapB.current.lat).toBeCloseTo(CHEYENNE.lat, 8)
    expect(await getJson('/api/map')).toEqual(mapB) // active trip is the default scope

    const legsA = await getJson(`/api/legs?trip=${tripA.id}`)
    expect(legsA).toHaveLength(1)
    expect(legsA[0].destination_name).toBe('Loveland')
    const legsB = await getJson(`/api/legs?trip=${tripB.id}`)
    expect(legsB).toHaveLength(1)
    expect(legsB[0].destination_name).toBe('Cheyenne')
    expect(legsB[0].leg_index).toBe(0)
    expect(await getJson('/api/legs')).toEqual(legsB)

    const listA = await getJson(`/api/checklist?trip=${tripA.id}`)
    expect(listA.states.map((s: any) => s.state_code)).toEqual(['CO'])
    expect(listA.cities.map((c: any) => c.city).sort()).toEqual(['Denver', 'Loveland'])
    const listB = await getJson(`/api/checklist?trip=${tripB.id}`)
    expect(listB.states.map((s: any) => s.state_code)).toEqual(['CO', 'WY'])
    expect(listB.cities.map((c: any) => c.city).sort()).toEqual(['Cheyenne', 'Denver'])
    // The between-trips city belongs to no trip's checklist.
    expect([...listA.cities, ...listB.cities].map((c: any) => c.city)).not.toContain('Fort Collins')
  })

  it('per-trip summaries partition breadcrumb mileage [TRIP-008]', async () => {
    const a = await getJson(`/api/trips/${tripA.id}/summary`)
    const refA = pathMiles(aTrail)
    expect(Math.abs(a.miles - refA) / refA).toBeLessThan(0.005)
    expect(a.states_count).toBe(1)

    const b = await getJson(`/api/trips/${tripB.id}/summary`)
    const refB = pathMiles(bTrail)
    expect(Math.abs(b.miles - refB) / refB).toBeLessThan(0.005)
    expect(b.states_count).toBe(2)
  })

  it('rebuilding read models reproduces identical per-trip state [TRIP-006]', async () => {
    const dump = async () => ({
      pings: (await t.db.pool.query('SELECT lat, lon, client_ts, state_code, leg_index FROM pings ORDER BY client_ts, seq')).rows,
      stops: (
        await t.db.pool.query(
          `SELECT anchor_lat, anchor_lon, started_at, ended_at, duration_min, journal_worthy, place, leg_index, trip_id
           FROM stops ORDER BY started_at`,
        )
      ).rows,
      legs: (
        await t.db.pool.query(
          'SELECT leg_index, destination_id, trip_id, started_at, arrived_at, summary FROM legs ORDER BY started_at',
        )
      ).rows,
      cities: (await t.db.pool.query('SELECT city, state_code, first_at, trip_id FROM cities_visited ORDER BY first_at, city')).rows,
      destinations: (await t.db.pool.query('SELECT id, status, arrived_at, trip_id FROM destinations ORDER BY created_at')).rows,
      engine: await engineData(),
      eventCount: (await t.db.pool.query('SELECT COUNT(*)::int AS n FROM events')).rows[0].n,
    })

    const before = await dump()
    await rebuildReadModels(t.db.pool)
    const after = await dump()

    expect(after.pings).toEqual(before.pings)
    expect(after.stops).toEqual(before.stops)
    expect(after.legs).toEqual(before.legs)
    expect(after.cities).toEqual(before.cities)
    expect(after.destinations).toEqual(before.destinations)
    expect(after.engine.trip_id).toBe(before.engine.trip_id)
    expect(after.engine.leg_index).toBe(before.engine.leg_index)
    expect(after.engine.state_code).toBe(before.engine.state_code)
    expect(after.engine.trip_miles).toBeCloseTo(before.engine.trip_miles, 9)
    expect(after.eventCount).toBe(before.eventCount) // rebuild derives no new events
  })
})
