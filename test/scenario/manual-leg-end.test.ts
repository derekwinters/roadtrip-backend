import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { offsetMeters, pathMiles, type LatLon } from '../../src/location/geo.js'
import { rebuildReadModels } from '../../src/location/engine.js'

const opened: TestApp[] = []
afterAll(async () => {
  for (const t of opened) await t.close()
})

interface TestPing {
  lat: number
  lon: number
  ts: string
}

async function sync(t: TestApp, profileId: string, pings: TestPing[]) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sync/batch',
    headers: asProfile(profileId),
    payload: {
      device_id: 'leg-end-test',
      events: pings.map((pg) => ({
        event_id: randomUUID(),
        type: 'location.ping',
        client_ts: pg.ts,
        payload: { lat: pg.lat, lon: pg.lon },
      })),
    },
  })
  expect(res.statusCode).toBe(200)
}

const dests = async (t: TestApp, p: string): Promise<any[]> =>
  (await t.app.inject({ method: 'GET', url: '/api/destinations', headers: asProfile(p) })).json()
const legs = async (t: TestApp, p: string): Promise<any[]> =>
  (await t.app.inject({ method: 'GET', url: '/api/legs', headers: asProfile(p) })).json()
const addDest = (t: TestApp, p: string, name: string, pt: LatLon) =>
  t.app.inject({
    method: 'POST',
    url: '/api/destinations',
    headers: asProfile(p),
    payload: { name, lat: pt.lat, lon: pt.lon },
  })
const endLeg = (t: TestApp, p: string) =>
  t.app.inject({ method: 'POST', url: '/api/trip/leg/end', headers: asProfile(p) })

const DENVER: LatLon = { lat: 39.7392, lon: -104.9903 }

describe('manual end leg marks the active destination arrived without advancing [LOC-013]', () => {
  it('records the leg at ~now with the right summary and leaves no active destination [LOC-013]', async () => {
    const t = await createTestApp()
    opened.push(t)
    const parent = await t.addProfile('Dad', 'parent')

    const start = Date.now() - 30 * 60_000
    const at = (min: number) => new Date(start + min * 60_000).toISOString()
    // Moving the whole time (km-scale hops): no stop ever opens, so an automatic arrival
    // is impossible — the only way this destination arrives is the manual end.
    const route = [DENVER, offsetMeters(DENVER, 2000, 0), offsetMeters(DENVER, 4000, 0), offsetMeters(DENVER, 6000, 0)]
    await sync(t, parent.id, route.map((pt, i) => ({ ...pt, ts: at(i * 10) })))

    const resB = await addDest(t, parent.id, 'Grandmas House', offsetMeters(DENVER, 6500, 0))
    expect(resB.statusCode).toBe(201)
    expect((await dests(t, parent.id))[0].status).toBe('active')

    const before = Date.now()
    const res = await endLeg(t, parent.id)
    expect(res.statusCode).toBe(200)
    const arrived = res.json()
    expect(arrived.status).toBe('arrived')
    // Timestamped at the request time (now), not backdated to a stop.
    expect(Date.parse(arrived.arrived_at)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(arrived.arrived_at)).toBeLessThanOrEqual(Date.now())

    const d = await dests(t, parent.id)
    expect(d[0].status).toBe('arrived')
    expect(d.some((x) => x.status === 'active')).toBe(false) // did NOT auto-advance

    const l = await legs(t, parent.id)
    expect(l).toHaveLength(1)
    expect(l[0].destination_id).toBe(arrived.id)
    expect(l[0].summary.miles).toBeCloseTo(pathMiles(route), 3)
    expect(l[0].summary.states).toContain('CO')
    expect(l[0].summary.wall_minutes).toBeGreaterThan(0)
  })

  it('returns 409 when there is no active destination [LOC-013]', async () => {
    const t = await createTestApp()
    opened.push(t)
    const parent = await t.addProfile('Dad', 'parent')
    const res = await endLeg(t, parent.id)
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('conflict')
  })

  it('is parent-only [LOC-013]', async () => {
    const t = await createTestApp()
    opened.push(t)
    const parent = await t.addProfile('Dad', 'parent')
    const kid = await t.addProfile('Sam', 'kid')
    await addDest(t, parent.id, 'Grandmas House', offsetMeters(DENVER, 6500, 0))
    const res = await endLeg(t, kid.id)
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('parent_required')
  })

  it('after a manual end, adding a new pin activates it and a normal arrival there records leg 2 [LOC-013]', async () => {
    const t = await createTestApp()
    opened.push(t)
    const parent = await t.addProfile('Dad', 'parent')

    const start = Date.now() - 30 * 60_000
    const at = (min: number) => new Date(start + min * 60_000).toISOString()
    await sync(t, parent.id, [
      { ...DENVER, ts: at(0) },
      { ...offsetMeters(DENVER, 3000, 0), ts: at(10) },
    ])
    await addDest(t, parent.id, 'First', offsetMeters(DENVER, 3500, 0))
    expect((await endLeg(t, parent.id)).statusCode).toBe(200)
    expect(await legs(t, parent.id)).toHaveLength(1)
    expect((await dests(t, parent.id)).some((x) => x.status === 'active')).toBe(false)

    // Adding the next pin activates it exactly as today (reconcile on POST /api/destinations).
    const B = offsetMeters(DENVER, 20000, 0)
    expect((await addDest(t, parent.id, 'Second', B)).statusCode).toBe(201)
    expect((await dests(t, parent.id)).find((x) => x.status === 'active')?.name).toBe('Second')

    // Drive to B and park on it — a normal automatic arrival records leg 2.
    const t2 = Date.now()
    const at2 = (s: number) => new Date(t2 + s * 1000).toISOString()
    await sync(t, parent.id, [
      { ...offsetMeters(B, -1000, 0), ts: at2(60) },
      { ...B, ts: at2(120) }, // stationary pair opens a stop anchored on B
      { ...B, ts: at2(180) },
    ])

    const l = await legs(t, parent.id)
    expect(l).toHaveLength(2)
    const second = (await dests(t, parent.id)).find((x) => x.name === 'Second')
    expect(second.status).toBe('arrived')
    expect(l[1].destination_id).toBe(second.id)
    expect(l[1].leg_index).toBe(1)
  })

  it('rebuild replays the manual end so legs and destinations are byte-for-byte identical [LOC-013]', async () => {
    const t = await createTestApp()
    opened.push(t)
    const parent = await t.addProfile('Dad', 'parent')

    const start = Date.now() - 60 * 60_000
    const at = (min: number) => new Date(start + min * 60_000).toISOString()
    // Leg 1: drive then manually end (no auto arrival).
    await sync(t, parent.id, [
      { ...DENVER, ts: at(0) },
      { ...offsetMeters(DENVER, 3000, 0), ts: at(10) },
    ])
    await addDest(t, parent.id, 'First', offsetMeters(DENVER, 3500, 0))
    expect((await endLeg(t, parent.id)).statusCode).toBe(200)

    // Leg 2: a normal automatic arrival at a later destination.
    const B = offsetMeters(DENVER, 20000, 0)
    await addDest(t, parent.id, 'Second', B)
    const t2 = Date.now()
    const at2 = (s: number) => new Date(t2 + s * 1000).toISOString()
    await sync(t, parent.id, [
      { ...offsetMeters(B, -1000, 0), ts: at2(60) },
      { ...B, ts: at2(120) },
      { ...B, ts: at2(180) },
    ])

    const dump = async () => ({
      legs: (
        await t.db.pool.query(
          'SELECT leg_index, destination_id, started_at, arrived_at, summary, trip_id FROM legs ORDER BY leg_index',
        )
      ).rows,
      destinations: (
        await t.db.pool.query('SELECT id, name, status, arrived_at FROM destinations ORDER BY order_index')
      ).rows,
      pings: (await t.db.pool.query('SELECT lat, lon, client_ts, state_code, leg_index FROM pings ORDER BY client_ts, seq')).rows,
      stops: (
        await t.db.pool.query(
          'SELECT anchor_lat, anchor_lon, started_at, ended_at, journal_worthy, leg_index, arrival_destination_id FROM stops ORDER BY started_at',
        )
      ).rows,
    })

    const before = await dump()
    expect(before.legs).toHaveLength(2)

    await rebuildReadModels(t.db.pool)
    const after = await dump()

    expect(after.legs).toEqual(before.legs)
    expect(after.destinations).toEqual(before.destinations)
    expect(after.pings).toEqual(before.pings)
    expect(after.stops).toEqual(before.stops)
  })
})
