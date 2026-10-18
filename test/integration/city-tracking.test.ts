import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { offsetMeters, type LatLon } from '../../src/location/geo.js'
import { rebuildReadModels } from '../../src/location/engine.js'

/**
 * City tracking toggles and the population threshold (docs/spec/06-location.md GEO-004,
 * GEO-006..009; docs/spec/05-config.md CFG-009).
 */

const T0 = Date.parse('2026-07-01T08:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

const DENVER = { lat: 39.7392, lon: -104.9903 }
const CHEYENNE = { lat: 41.14, lon: -104.8202 }
const NEAR_LONGMONT = { lat: 40.16, lon: -105.06 }
const LOVELAND = { lat: 40.39776, lon: -105.07498 }
const FORT_COLLINS = { lat: 40.5853, lon: -105.0844 }
const MEAD = { lat: 40.23332, lon: -104.99859 } // population 4,476 in the bundled list

const p = (pt: LatLon, min: number) => ({ lat: pt.lat, lon: pt.lon, ts: at(min) })

async function syncPings(t: TestApp, profileId: string, pings: Array<{ lat: number; lon: number; ts: string }>) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sync/batch',
    headers: asProfile(profileId),
    payload: {
      device_id: 'city-test',
      events: pings.map((pg) => ({
        event_id: randomUUID(),
        type: 'location.ping',
        client_ts: pg.ts,
        payload: { lat: pg.lat, lon: pg.lon },
      })),
    },
  })
  expect(res.statusCode).toBe(200)
  for (const r of res.json().results) expect(r.status).toBe('accepted')
}

async function eventsOfType(t: TestApp, profileId: string, type: string) {
  const res = await t.app.inject({ method: 'GET', url: `/api/events?types=${type}&limit=500`, headers: asProfile(profileId) })
  return res.json().events as Array<{ seq: number; type: string; payload: any; client_ts: string }>
}

async function putConfig(t: TestApp, profileId: string, payload: Record<string, unknown>) {
  const res = await t.app.inject({ method: 'PUT', url: '/api/config', headers: asProfile(profileId), payload })
  expect(res.statusCode).toBe(200)
}

async function visited(t: TestApp) {
  const { rows } = await t.db.pool.query('SELECT city, state_code, first_at FROM cities_visited ORDER BY first_at, city')
  return rows.map((r: any) => ({ city: r.city, state_code: r.state_code, first_at: r.first_at.toISOString() }))
}

/** A journal-worthy stop at `pt`: approach, two stationary pings, leave 3 km away 14 min later. */
const stopAt = (pt: LatLon, startMin: number) => [
  p(offsetMeters(pt, -6000, 0), startMin - 4),
  p(offsetMeters(pt, -3000, 0), startMin - 2),
  p(pt, startMin),
  p(pt, startMin + 2),
  p(offsetMeters(pt, 3000, 0), startMin + 14),
]

describe('travel-through toggle', () => {
  let t: TestApp
  let parent: { id: string }

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
  })
  afterAll(async () => await t.close())

  it('records no pass-through city while track_cities_through is false [GEO-007]', async () => {
    await putConfig(t, parent.id, { track_cities_through: false })
    await syncPings(t, parent.id, [p(DENVER, 0), p(offsetMeters(DENVER, 2000, 0), 2)])
    expect(await eventsOfType(t, parent.id, 'location.crossing.city')).toHaveLength(0)
    expect(await visited(t)).toEqual([])
  })

  it('records pass-through cities once per trip when switched back on, for later pings only [GEO-004] [CFG-009]', async () => {
    await putConfig(t, parent.id, { track_cities_through: true })
    await syncPings(t, parent.id, [p(CHEYENNE, 60), p(offsetMeters(CHEYENNE, 3000, 0), 62)])
    const events = await eventsOfType(t, parent.id, 'location.crossing.city')
    expect(events.filter((e) => e.payload.city === 'Cheyenne')).toHaveLength(1)
    expect(events.find((e) => e.payload.city === 'Cheyenne')!.client_ts).toBe(at(60))
    // Forward-only (LOC-001): the earlier Denver pings are never re-evaluated.
    expect(events.some((e) => e.payload.city === 'Denver')).toBe(false)
  })
})

describe('stop toggle on', () => {
  let t: TestApp
  let parent: { id: string }

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Mom', 'parent')
  })
  afterAll(async () => await t.close())

  it('records the city of a journal-worthy stop, stamped with the stop start [GEO-008]', async () => {
    await putConfig(t, parent.id, { track_cities_through: false }) // isolate the stop path
    await syncPings(t, parent.id, stopAt(NEAR_LONGMONT, 4))

    const ended = await eventsOfType(t, parent.id, 'location.stop.ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]!.payload).toMatchObject({ journal_worthy: true, place: 'Longmont' })

    const events = await eventsOfType(t, parent.id, 'location.crossing.city')
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toEqual({ city: 'Longmont', state_code: 'CO' })
    expect(events[0]!.client_ts).toBe(at(4))
    expect(await visited(t)).toEqual([{ city: 'Longmont', state_code: 'CO', first_at: at(4) }])
  })

  it('does not record a city for a stop shorter than min_stop_duration_min [GEO-008]', async () => {
    const S = offsetMeters(FORT_COLLINS, 0, 300)
    await syncPings(t, parent.id, [p(S, 30), p(S, 32), p(offsetMeters(S, 3000, 0), 37)]) // 7 min
    const ended = await eventsOfType(t, parent.id, 'location.stop.ended')
    expect(ended.at(-1)!.payload.journal_worthy).toBe(false)
    expect((await eventsOfType(t, parent.id, 'location.crossing.city')).map((e) => e.payload.city)).toEqual(['Longmont'])
  })

  it('does not duplicate a stop city on a later pass-through, nor a pass-through city on a later stop [GEO-008] [GEO-004]', async () => {
    await putConfig(t, parent.id, { track_cities_through: true })
    // Back through Longmont (already recorded by the stop).
    await syncPings(t, parent.id, [p({ lat: 40.16721, lon: -105.10193 }, 60)])
    // Pass through Loveland, then stop there.
    await syncPings(t, parent.id, [p(LOVELAND, 80), ...stopAt(offsetMeters(LOVELAND, 0, 500), 90).slice(2)])

    const ended = await eventsOfType(t, parent.id, 'location.stop.ended')
    expect(ended.at(-1)!.payload).toMatchObject({ journal_worthy: true, place: 'Loveland' })

    const events = await eventsOfType(t, parent.id, 'location.crossing.city')
    const longmont = events.filter((e) => e.payload.city === 'Longmont')
    const loveland = events.filter((e) => e.payload.city === 'Loveland')
    expect(longmont).toHaveLength(1)
    expect(loveland).toHaveLength(1)
    expect(loveland[0]!.client_ts).toBe(at(80)) // the pass-through came first
    const rows = await visited(t)
    expect(rows.filter((r) => r.city === 'Longmont')).toHaveLength(1)
    expect(rows.filter((r) => r.city === 'Loveland')).toEqual([{ city: 'Loveland', state_code: 'CO', first_at: at(80) }])
  })

})

describe('stop-recorded cities survive a rebuild', () => {
  let t: TestApp
  let parent: { id: string }

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
  })
  afterAll(async () => await t.close())

  it('rebuilds the same visited cities from the event stream under unchanged config [GEO-008] [GEO-004]', async () => {
    // Stop path only (a stop-recorded city is backdated to the stop start), then a pass-through.
    await putConfig(t, parent.id, { track_cities_through: false })
    await syncPings(t, parent.id, stopAt(NEAR_LONGMONT, 4))
    const before = await visited(t)
    expect(before).toEqual([{ city: 'Longmont', state_code: 'CO', first_at: at(4) }])
    await rebuildReadModels(t.db.pool)
    expect(await visited(t)).toEqual(before)
  })
})

describe('stop toggle off', () => {
  let t: TestApp
  let parent: { id: string }

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
  })
  afterAll(async () => await t.close())

  it('keeps the place label but records no visited city while track_cities_stopped is false [GEO-008] [GEO-006]', async () => {
    await putConfig(t, parent.id, { track_cities_through: false, track_cities_stopped: false })
    await syncPings(t, parent.id, stopAt(FORT_COLLINS, 4))
    const ended = await eventsOfType(t, parent.id, 'location.stop.ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]!.payload).toMatchObject({ journal_worthy: true, place: 'Fort Collins' })
    expect(await eventsOfType(t, parent.id, 'location.crossing.city')).toHaveLength(0)
    expect(await visited(t)).toEqual([])
  })
})

describe('minimum city population', () => {
  let t: TestApp
  let parent: { id: string }

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Mom', 'parent')
  })
  afterAll(async () => await t.close())

  it('ignores places below city_min_population, and a lowered threshold applies to later pings only [GEO-009] [CFG-009]', async () => {
    await putConfig(t, parent.id, { city_radius_km: 2 }) // only Mead is this close; default minimum 5000
    await syncPings(t, parent.id, [p(MEAD, 0)])
    expect(await eventsOfType(t, parent.id, 'location.crossing.city')).toHaveLength(0)

    await putConfig(t, parent.id, { city_min_population: 0 })
    await syncPings(t, parent.id, [p(offsetMeters(MEAD, 0, 500), 5)])
    const events = await eventsOfType(t, parent.id, 'location.crossing.city')
    expect(events.map((e) => e.payload)).toEqual([{ city: 'Mead', state_code: 'CO' }])
    expect(events[0]!.client_ts).toBe(at(5))
  })

  it('applies the threshold to the stop place label too [GEO-009] [GEO-006]', async () => {
    await putConfig(t, parent.id, { city_min_population: 5000, track_cities_through: false })
    await syncPings(t, parent.id, stopAt(offsetMeters(MEAD, 0, -300), 30))
    const ended = await eventsOfType(t, parent.id, 'location.stop.ended')
    expect(ended.at(-1)!.payload).toMatchObject({ journal_worthy: true, place: null })
  })
})
