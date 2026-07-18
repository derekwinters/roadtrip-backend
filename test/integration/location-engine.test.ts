import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { haversineMiles, offsetMeters, pathMiles, type LatLon } from '../../src/location/geo.js'
import { rebuildReadModels } from '../../src/location/engine.js'
import { appendEvent } from '../../src/events/store.js'

const T0 = Date.parse('2026-07-01T08:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

const DENVER = { lat: 39.7392, lon: -104.9903 }
const CHEYENNE = { lat: 41.14, lon: -104.8202 }
const PACIFIC = { lat: 37.7, lon: -123.5 }
const NEAR_LONGMONT = { lat: 40.16, lon: -105.06 }
const FORT_COLLINS = { lat: 40.5853, lon: -105.0844 }
const WELLINGTON = { lat: 40.7, lon: -105.0 }

interface TestPing {
  lat: number
  lon: number
  ts: string
  event_id?: string
}

const p = (pt: LatLon, min: number, event_id?: string): TestPing => ({ lat: pt.lat, lon: pt.lon, ts: at(min), event_id })

async function syncPings(t: TestApp, profileId: string, pings: TestPing[]) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sync/batch',
    headers: asProfile(profileId),
    payload: {
      device_id: 'engine-test',
      events: pings.map((pg) => ({
        event_id: pg.event_id ?? randomUUID(),
        type: 'location.ping',
        client_ts: pg.ts,
        payload: { lat: pg.lat, lon: pg.lon },
      })),
    },
  })
  expect(res.statusCode).toBe(200)
  return res.json().results as Array<{ status: string; seq?: number }>
}

async function eventsOfType(t: TestApp, profileId: string, type: string) {
  const res = await t.app.inject({ method: 'GET', url: `/api/events?types=${type}&limit=500`, headers: asProfile(profileId) })
  return res.json().events as Array<{ seq: number; type: string; payload: any; client_ts: string; actor_id: string | null }>
}

describe('ping ingestion & geocoding', () => {
  let t: TestApp
  let parent: { id: string }
  let kid: { id: string }

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
    kid = await t.addProfile('Sam', 'kid')
  })
  afterAll(async () => await t.close())

  it('emits a state crossing with prev=null for the first ping of the trip [GEO-003] and annotates it [GEO-001]', async () => {
    await syncPings(t, parent.id, [p(DENVER, 0)])
    const crossings = await eventsOfType(t, parent.id, 'location.crossing.state')
    expect(crossings).toHaveLength(1)
    expect(crossings[0]!.payload).toEqual({ state: 'Colorado', state_code: 'CO', prev_state_code: null })
    expect(crossings[0]!.client_ts).toBe(at(0))
    const { rows } = await t.db.pool.query('SELECT state_code FROM pings ORDER BY client_ts')
    expect(rows[0]!.state_code).toBe('CO')
  })

  it('accepts pings only from parents and processes each accepted ping exactly once on re-sync [LOC-001]', async () => {
    const denied = await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(kid.id),
      payload: {
        events: [{ event_id: randomUUID(), type: 'location.ping', client_ts: at(1), payload: { lat: 39.75, lon: -104.99 } }],
      },
    })
    expect(denied.json().results[0]).toMatchObject({ status: 'rejected', reason: 'not_parent' })

    const eventId = randomUUID()
    const ping2 = { ...p(offsetMeters(DENVER, 2000, 0), 1), event_id: eventId }
    const first = await syncPings(t, parent.id, [ping2])
    expect(first[0]!.status).toBe('accepted')
    const countAfterFirst = await t.db.pool.query('SELECT COUNT(*)::int AS n FROM pings')
    const stateAfterFirst = await t.db.pool.query('SELECT data FROM engine_state WHERE id = 1')

    const retry = await syncPings(t, parent.id, [ping2])
    expect(retry[0]!.status).toBe('duplicate')
    const countAfterRetry = await t.db.pool.query('SELECT COUNT(*)::int AS n FROM pings')
    expect(countAfterRetry.rows[0]!.n).toBe(countAfterFirst.rows[0]!.n)
    const stateAfterRetry = await t.db.pool.query('SELECT data FROM engine_state WHERE id = 1')
    expect(stateAfterRetry.rows[0]!.data.trip_miles).toBe(stateAfterFirst.rows[0]!.data.trip_miles)
  })

  it('emits location.crossing.state with new and previous codes when the state changes [GEO-002]', async () => {
    await syncPings(t, parent.id, [p(CHEYENNE, 30)])
    const crossings = await eventsOfType(t, parent.id, 'location.crossing.state')
    expect(crossings).toHaveLength(2)
    expect(crossings[1]!.payload).toEqual({ state: 'Wyoming', state_code: 'WY', prev_state_code: 'CO' })
  })

  it('keeps the previous state and stays silent on point-in-polygon misses [GEO-005]', async () => {
    await syncPings(t, parent.id, [p(PACIFIC, 40)])
    const crossings = await eventsOfType(t, parent.id, 'location.crossing.state')
    expect(crossings).toHaveLength(2) // no new crossing
    const { rows } = await t.db.pool.query('SELECT state_code FROM pings WHERE client_ts = $1', [at(40)])
    expect(rows[0]!.state_code).toBe('WY') // annotation carries the previous state
  })

  it('records each city at most once per trip [GEO-004]', async () => {
    await syncPings(t, parent.id, [p(DENVER, 50)]) // back through Denver a second time
    const cityEvents = await eventsOfType(t, parent.id, 'location.crossing.city')
    const denverEvents = cityEvents.filter((e) => e.payload.city === 'Denver')
    expect(denverEvents).toHaveLength(1)
    expect(denverEvents[0]!.payload).toEqual({ city: 'Denver', state_code: 'CO' })
    expect(denverEvents[0]!.client_ts).toBe(at(0)) // first pass, not the return
    const cheyenneEvents = cityEvents.filter((e) => e.payload.city === 'Cheyenne')
    expect(cheyenneEvents).toHaveLength(1)
    const { rows } = await t.db.pool.query('SELECT city, first_at FROM cities_visited ORDER BY first_at')
    expect(rows.map((r: any) => r.city)).toContain('Denver')
    expect(rows.filter((r: any) => r.city === 'Denver')).toHaveLength(1)
  })
})

describe('stop lifecycle', () => {
  let t: TestApp
  let parent: { id: string }
  const S = NEAR_LONGMONT

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Mom', 'parent')
  })
  afterAll(async () => await t.close())

  it('opens a stop on the second consecutive ping within stop_radius_m, backdating start to the anchor ping [LOC-002] [LOC-003]', async () => {
    await syncPings(t, parent.id, [
      p(offsetMeters(S, -6000, 0), 0),
      p(offsetMeters(S, -3000, 0), 2),
      p(S, 4), // anchor: first ping of the stationary run
      p(S, 6), // second consecutive ping within radius -> opens
    ])
    const started = await eventsOfType(t, parent.id, 'location.stop.started')
    expect(started).toHaveLength(1)
    expect(started[0]!.client_ts).toBe(at(4)) // backdated to the anchor ping timestamp
    expect(started[0]!.payload.lat).toBeCloseTo(S.lat, 8)
    expect(started[0]!.payload.lon).toBeCloseTo(S.lon, 8)
    const { rows } = await t.db.pool.query('SELECT started_at, ended_at FROM stops')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.started_at.toISOString()).toBe(at(4))
    expect(rows[0]!.ended_at).toBeNull()
  })

  it('drift within the radius of the anchor keeps the stop open; a farther ping ends it with ping-derived timings [LOC-004]', async () => {
    await syncPings(t, parent.id, [
      p(offsetMeters(S, 60, 0), 8), // 60 m from anchor: still stopped, no event
      p(offsetMeters(S, 3000, 0), 18), // ends the stop
    ])
    const started = await eventsOfType(t, parent.id, 'location.stop.started')
    expect(started).toHaveLength(1) // no flapping from the drift ping
    const ended = await eventsOfType(t, parent.id, 'location.stop.ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]!.payload).toMatchObject({
      started_at: at(4),
      ended_at: at(18),
      duration_min: 14,
      journal_worthy: true,
    })
    expect(ended[0]!.payload.stop_id).toBe(started[0]!.payload.stop_id)
  })

  it('annotates journal-worthy stops with the nearest city as place [GEO-006]', async () => {
    const ended = await eventsOfType(t, parent.id, 'location.stop.ended')
    expect(ended[0]!.payload.place).toBe('Longmont')
    const { rows } = await t.db.pool.query('SELECT place FROM stops WHERE journal_worthy')
    expect(rows[0]!.place).toBe('Longmont')
  })

  it('flags stops shorter than min_stop_duration_min journal_worthy=false and excludes them from the checklist [LOC-005]', async () => {
    const S2 = offsetMeters(S, 6000, 0)
    await syncPings(t, parent.id, [
      p(S2, 20),
      p(S2, 26), // opens, backdated to min 20
      p(offsetMeters(S, 9000, 0), 27), // closes: 7 min < 10
    ])
    const ended = await eventsOfType(t, parent.id, 'location.stop.ended')
    expect(ended).toHaveLength(2)
    expect(ended[1]!.payload).toMatchObject({ duration_min: 7, journal_worthy: false })
    const checklist = await t.app.inject({ method: 'GET', url: '/api/checklist', headers: asProfile(parent.id) })
    const stops = checklist.json().stops as Array<{ started_at: string }>
    expect(stops).toHaveLength(1) // only the journal-worthy one
    expect(stops[0]!.started_at).toBe(at(4))
  })

  it('folds late pings into the breadcrumb in timestamp order without reopening closed stops [LOC-010]', async () => {
    const before = await t.db.pool.query('SELECT id, started_at, ended_at FROM stops ORDER BY started_at')
    // A ping from the middle of the first stop's window (min 10), 5+ km away from its anchor:
    // had it arrived live it would have ended the stop at min 10.
    const late = offsetMeters(S, 5000, 5000)
    await syncPings(t, parent.id, [p(late, 10)])

    const after = await t.db.pool.query('SELECT id, started_at, ended_at FROM stops ORDER BY started_at')
    expect(after.rows).toEqual(before.rows) // stops untouched
    const ended = await eventsOfType(t, parent.id, 'location.stop.ended')
    expect(ended).toHaveLength(2)
    expect(ended[0]!.payload.ended_at).toBe(at(18)) // not retroactively re-ended

    const map = await t.app.inject({ method: 'GET', url: '/api/map', headers: asProfile(parent.id) })
    const crumbs = map.json().breadcrumb as Array<{ lat: number; lon: number; ts: string }>
    const tss = crumbs.map((c) => c.ts)
    expect(tss).toEqual([...tss].sort()) // chronological
    const idx = tss.indexOf(at(10))
    expect(idx).toBeGreaterThan(-1)
    expect(crumbs[idx]!.lat).toBeCloseTo(late.lat, 8)
    expect(tss[idx - 1]).toBe(at(8))
    expect(tss[idx + 1]).toBe(at(18))
  })
})

describe('arrivals, map state & mileage', () => {
  let t: TestApp
  let parent: { id: string }
  let d1: any
  let d2: any
  const D1 = { lat: 40.4, lon: -104.99 }
  const D2 = FORT_COLLINS
  const route: TestPing[] = []

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
    const mk = async (name: string, pt: LatLon) => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/destinations',
        headers: asProfile(parent.id),
        payload: { name, lat: pt.lat, lon: pt.lon },
      })
      expect(res.statusCode).toBe(201)
      return res.json()
    }
    d1 = await mk('Loveland Rest', D1)
    d2 = await mk('Fort Collins', D2)
  })
  afterAll(async () => await t.close())

  it('a stop anchored within arrival_radius_m of the active destination arrives once and advances the tracker [LOC-006]', async () => {
    const approach = offsetMeters(D1, -111, 0)
    route.push(p({ lat: 39.74, lon: -104.99 }, 0), p({ lat: 40.0, lon: -104.99 }, 20), p(approach, 45), p(approach, 50))
    await syncPings(t, parent.id, route.slice(0, 4))

    let arrived = await eventsOfType(t, parent.id, 'trip.leg.arrived')
    expect(arrived).toHaveLength(1)
    expect(arrived[0]!.payload.destination_id).toBe(d1.id)
    expect(arrived[0]!.payload.destination_name).toBe('Loveland Rest')
    expect(arrived[0]!.client_ts).toBe(at(45)) // arrival at the stop anchor timestamp

    let dests = (await t.app.inject({ method: 'GET', url: '/api/destinations', headers: asProfile(parent.id) })).json()
    expect(dests.find((d: any) => d.id === d1.id)).toMatchObject({ status: 'arrived' })
    expect(new Date(dests.find((d: any) => d.id === d1.id).arrived_at).toISOString()).toBe(at(45))
    expect(dests.find((d: any) => d.id === d2.id)).toMatchObject({ status: 'active' })

    // Drive on and stop at destination 2.
    const dep = offsetMeters(D1, 2889, 0)
    route.push(p(dep, 60), p(D2, 90), p(D2, 95))
    await syncPings(t, parent.id, route.slice(4, 7))
    arrived = await eventsOfType(t, parent.id, 'trip.leg.arrived')
    expect(arrived).toHaveLength(2)
    expect(arrived[1]!.payload.destination_id).toBe(d2.id)

    // Stop near destination 1 again: it is already arrived, no re-arrival, no third leg.
    route.push(p(offsetMeters(D2, 3000, 0), 100), p(D1, 110), p(D1, 115))
    await syncPings(t, parent.id, route.slice(7, 10))
    arrived = await eventsOfType(t, parent.id, 'trip.leg.arrived')
    expect(arrived).toHaveLength(2)
    dests = (await t.app.inject({ method: 'GET', url: '/api/destinations', headers: asProfile(parent.id) })).json()
    expect(dests.every((d: any) => d.status === 'arrived')).toBe(true)
    const legs = await t.db.pool.query('SELECT leg_index FROM legs ORDER BY leg_index')
    expect(legs.rows.map((r: any) => r.leg_index)).toEqual([0, 1])
  })

  it('serves map state: latest position, start, breadcrumb, active destination, remaining distance, leg progress [LOC-008]', async () => {
    // Add a fresh pending destination so there is an active one again.
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/destinations',
      headers: asProfile(parent.id),
      payload: { name: 'Cheyenne', lat: CHEYENNE.lat, lon: CHEYENNE.lon },
    })
    const d3 = res.json()
    expect(d3.status).toBe('active')

    const map = (await t.app.inject({ method: 'GET', url: '/api/map', headers: asProfile(parent.id) })).json()
    const last = route[route.length - 1]!
    expect(map.current.lat).toBeCloseTo(last.lat, 8)
    expect(map.current.ts).toBe(at(115))
    expect(map.start.lat).toBeCloseTo(39.74, 8)
    expect(map.breadcrumb).toHaveLength(route.length)
    expect(map.active_destination.id).toBe(d3.id)
    expect(map.remaining_mi).toBeCloseTo(haversineMiles(last, CHEYENNE), 1)
    // Leg progress: miles driven since the last arrival (anchor at min 90).
    const legPath = pathMiles(route.slice(6).map(({ lat, lon }) => ({ lat, lon })))
    expect(map.leg_miles).toBeCloseTo(legPath, 4)

    const small = (
      await t.app.inject({ method: 'GET', url: '/api/map?max_points=4', headers: asProfile(parent.id) })
    ).json()
    expect(small.breadcrumb).toHaveLength(4)
    expect(small.breadcrumb[0].ts).toBe(at(0))
    expect(small.breadcrumb[3].ts).toBe(at(115))
  })

  it('trip and leg mileage equal the haversine breadcrumb sum within 0.5% [LOC-007]', async () => {
    const reference = pathMiles(route.map(({ lat, lon }) => ({ lat, lon })))
    const summary = (await t.app.inject({ method: 'GET', url: '/api/trip/summary', headers: asProfile(parent.id) })).json()
    expect(Math.abs(summary.miles - reference) / reference).toBeLessThan(0.005)

    const legs = (await t.app.inject({ method: 'GET', url: '/api/legs', headers: asProfile(parent.id) })).json()
    const leg0Ref = pathMiles(route.slice(0, 3).map(({ lat, lon }) => ({ lat, lon })))
    expect(Math.abs(legs[0].summary.miles - leg0Ref) / leg0Ref).toBeLessThan(0.005)
  })
})

describe('config tunables drive detection behavior', () => {
  let t: TestApp
  let parent: { id: string }
  const BASE = { lat: 39.9, lon: -104.99 }
  const N = (m: number) => offsetMeters(BASE, m, 0)

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
  })
  afterAll(async () => await t.close())

  const putConfig = async (payload: Record<string, number>) => {
    const res = await t.app.inject({ method: 'PUT', url: '/api/config', headers: asProfile(parent.id), payload })
    expect(res.statusCode).toBe(200)
  }

  it('changing stop_radius_m changes what counts as stationary, without restart [CFG-004]', async () => {
    await syncPings(t, parent.id, [p(BASE, 0), p(N(150), 2)]) // 150 m > default 100: not a stop
    expect(await eventsOfType(t, parent.id, 'location.stop.started')).toHaveLength(0)

    await putConfig({ stop_radius_m: 300 })
    await syncPings(t, parent.id, [p(N(5000), 4), p(N(5150), 6)]) // 150 m <= 300 now
    expect(await eventsOfType(t, parent.id, 'location.stop.started')).toHaveLength(1)
  })

  it('changing min_stop_duration_min changes journal-worthiness [CFG-004]', async () => {
    await syncPings(t, parent.id, [p(N(10000), 11)]) // closes the open stop: 7 min < default 10
    let ended = await eventsOfType(t, parent.id, 'location.stop.ended')
    expect(ended[0]!.payload.journal_worthy).toBe(false)

    await putConfig({ min_stop_duration_min: 5 })
    await syncPings(t, parent.id, [p(N(15000), 13), p(N(15000), 20), p(N(20000), 21)]) // 8-minute stop
    ended = await eventsOfType(t, parent.id, 'location.stop.ended')
    expect(ended).toHaveLength(2)
    expect(ended[1]!.payload).toMatchObject({ duration_min: 8, journal_worthy: true })
  })

  it('changing arrival_radius_m changes arrival detection [CFG-004]', async () => {
    const dest = N(30000)
    await t.app.inject({
      method: 'POST',
      url: '/api/destinations',
      headers: asProfile(parent.id),
      payload: { name: 'Far Stop', lat: dest.lat, lon: dest.lon },
    })
    const anchor = N(28800) // 1200 m short of the destination
    await syncPings(t, parent.id, [p(anchor, 30), p(anchor, 32)]) // stop opens; 1200 m > default 800
    expect(await eventsOfType(t, parent.id, 'trip.leg.arrived')).toHaveLength(0)

    await syncPings(t, parent.id, [p(N(25000), 34)]) // close that stop
    await putConfig({ arrival_radius_m: 2000 })
    await syncPings(t, parent.id, [p(anchor, 40), p(anchor, 42)]) // same anchor, wider radius
    expect(await eventsOfType(t, parent.id, 'trip.leg.arrived')).toHaveLength(1)
  })
})

describe('offline batch reconstruction', () => {
  it('a single flushed batch produces the same stops/crossings/arrivals as live delivery [SYNC-005]', async () => {
    const W = WELLINGTON
    const trail: TestPing[] = [
      p(FORT_COLLINS, 0),
      p(offsetMeters(FORT_COLLINS, 2000, 0), 2),
      p(W, 10),
      p(W, 14),
      p(W, 22),
      p(offsetMeters(W, 5000, 0), 26),
      p(CHEYENNE, 50),
    ]

    const live = await createTestApp()
    const shuffled = await createTestApp()
    try {
      const liveParent = await live.addProfile('Dad', 'parent')
      const batchParent = await shuffled.addProfile('Dad', 'parent')

      for (const ping of trail) await syncPings(live, liveParent.id, [ping]) // one batch per ping, in order
      const disorder = [trail[3]!, trail[6]!, trail[0]!, trail[5]!, trail[2]!, trail[4]!, trail[1]!]
      await syncPings(shuffled, batchParent.id, disorder) // one flush, shuffled inside the batch

      const dump = async (t: TestApp, profileId: string) => ({
        stops: (
          await t.db.pool.query(
            'SELECT anchor_lat, anchor_lon, started_at, ended_at, duration_min, journal_worthy, place FROM stops ORDER BY started_at',
          )
        ).rows,
        crossings: (await eventsOfType(t, profileId, 'location.crossing.state')).map((e) => ({
          payload: e.payload,
          client_ts: e.client_ts,
        })),
        pingCount: (await t.db.pool.query('SELECT COUNT(*)::int AS n FROM pings')).rows[0]!.n,
        tripMiles: (await t.db.pool.query('SELECT data FROM engine_state WHERE id = 1')).rows[0]!.data.trip_miles,
      })

      const a = await dump(live, liveParent.id)
      const b = await dump(shuffled, batchParent.id)
      expect(a.stops).toHaveLength(1)
      expect(b.stops).toEqual(a.stops)
      expect(b.crossings).toEqual(a.crossings)
      expect(b.pingCount).toBe(a.pingCount)
      expect(b.tripMiles).toBeCloseTo(a.tripMiles, 9)
    } finally {
      await live.close()
      await shuffled.close()
    }
  })
})

describe('event-stream rebuild', () => {
  it('read models rebuilt from raw events match incremental processing [SYS-002]', async () => {
    const t = await createTestApp()
    try {
      const parent = await t.addProfile('Dad', 'parent')
      await t.app.inject({
        method: 'POST',
        url: '/api/destinations',
        headers: asProfile(parent.id),
        payload: { name: 'Cheyenne', lat: CHEYENNE.lat, lon: CHEYENNE.lon },
      })
      // A game finishing mid-leg, so the rebuilt leg summary must re-derive games_played.
      await appendEvent(t.db.pool, {
        type: 'game.finished',
        actorId: null,
        payload: {
          game_id: randomUUID(),
          game_type: 'chess',
          result: 'win',
          winner_profile_id: parent.id,
          move_count: 20,
        },
        clientTs: at(30),
      })
      const W = WELLINGTON
      await syncPings(t, parent.id, [
        p(FORT_COLLINS, 0),
        p(W, 10),
        p(W, 14),
        p(W, 26), // 16-minute stop at Wellington
        p(offsetMeters(W, 5000, 0), 28),
        p(CHEYENNE, 50),
        p(CHEYENNE, 55), // arrival
        p(offsetMeters(CHEYENNE, 3000, 0), 70), // depart: closes the arrival stop
      ])

      const dump = async () => ({
        pings: (await t.db.pool.query('SELECT lat, lon, client_ts, state_code, leg_index FROM pings ORDER BY client_ts')).rows,
        stops: (
          await t.db.pool.query(
            `SELECT anchor_lat, anchor_lon, started_at, ended_at, duration_min, journal_worthy, place, leg_index,
                    arrival_destination_id
             FROM stops ORDER BY started_at`,
          )
        ).rows,
        legs: (await t.db.pool.query('SELECT leg_index, destination_id, started_at, arrived_at, summary FROM legs ORDER BY leg_index')).rows,
        cities: (await t.db.pool.query('SELECT city, state_code, first_at FROM cities_visited ORDER BY city')).rows,
        destinations: (await t.db.pool.query('SELECT id, status, arrived_at FROM destinations ORDER BY order_index')).rows,
        engine: (await t.db.pool.query('SELECT data FROM engine_state WHERE id = 1')).rows[0]!.data,
        eventCount: (await t.db.pool.query('SELECT COUNT(*)::int AS n FROM events')).rows[0]!.n,
      })

      const before = await dump()
      expect(before.stops.length).toBe(2)
      expect(before.legs.length).toBe(1)

      await rebuildReadModels(t.db.pool)
      const after = await dump()

      expect(after.pings).toEqual(before.pings)
      expect(after.stops).toEqual(before.stops)
      expect(after.legs).toEqual(before.legs)
      expect(after.cities).toEqual(before.cities)
      expect(after.destinations).toEqual(before.destinations)
      expect(after.engine.trip_miles).toBeCloseTo(before.engine.trip_miles, 9)
      expect(after.engine.leg_index).toBe(before.engine.leg_index)
      expect(after.engine.state_code).toBe(before.engine.state_code)
      // Append-only: rebuilding derives no new events (SYS-001).
      expect(after.eventCount).toBe(before.eventCount)
    } finally {
      await t.close()
    }
  })
})
