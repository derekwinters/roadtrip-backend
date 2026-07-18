import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { offsetMeters, pathMiles, type LatLon } from '../../src/location/geo.js'
import { appendEvent } from '../../src/events/store.js'

const T0 = Date.parse('2026-07-02T09:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

const DENVER = { lat: 39.7392, lon: -104.9903 }
const FORT_COLLINS = { lat: 40.5853, lon: -105.0844 }
const CHEYENNE = { lat: 41.14, lon: -104.8202 }
const LOVELAND_I25 = { lat: 40.4, lon: -104.99 }
const NEAR_LONGMONT = { lat: 40.16, lon: -105.06 }

interface TestPing {
  lat: number
  lon: number
  ts: string
}
const p = (pt: LatLon, min: number): TestPing => ({ lat: pt.lat, lon: pt.lon, ts: at(min) })

async function syncPings(t: TestApp, profileId: string, pings: TestPing[]) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sync/batch',
    headers: asProfile(profileId),
    payload: {
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

describe('checklist read model', () => {
  let t: TestApp
  let parent: { id: string }

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
    await syncPings(t, parent.id, [
      p(FORT_COLLINS, 0), // CO + Fort Collins city
      p(CHEYENNE, 40), // WY + Cheyenne city
      p(FORT_COLLINS, 80), // back into CO: re-entry
      p(LOVELAND_I25, 100),
      p(LOVELAND_I25, 105), // opens stop, backdated to min 100
      p(LOVELAND_I25, 112),
      p(offsetMeters(LOVELAND_I25, 4000, 0), 115), // closes: 15 min, journal-worthy
      p(offsetMeters(LOVELAND_I25, 9000, 0), 120),
      p(offsetMeters(LOVELAND_I25, 9000, 0), 124), // opens
      p(offsetMeters(LOVELAND_I25, 13000, 0), 125), // closes: 5 min, not journal-worthy
    ])
  })
  afterAll(async () => await t.close())

  it('returns states with first-entered timestamps, cities passed, and journal-worthy stops [LIST-001]', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/checklist', headers: asProfile(parent.id) })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.states).toEqual([
      { state: 'Colorado', state_code: 'CO', first_entered_at: at(0) },
      { state: 'Wyoming', state_code: 'WY', first_entered_at: at(40) },
    ])

    const cityNames = body.cities.map((c: any) => c.city)
    expect(cityNames).toContain('Fort Collins')
    expect(cityNames).toContain('Cheyenne')
    const fc = body.cities.find((c: any) => c.city === 'Fort Collins')
    expect(fc).toEqual({ city: 'Fort Collins', state_code: 'CO', first_at: at(0) })

    expect(body.stops).toHaveLength(1) // the 5-minute stop is excluded
    expect(body.stops[0]).toMatchObject({
      started_at: at(100),
      duration_min: 15,
      place: 'Loveland',
    })
    expect(body.stops[0].lat).toBeCloseTo(LOVELAND_I25.lat, 8)
  })

  it('lists each state once with the first crossing timestamp despite re-entry [LIST-002]', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/checklist', headers: asProfile(parent.id) })
    const states = res.json().states as Array<{ state_code: string; first_entered_at: string }>
    const co = states.filter((s) => s.state_code === 'CO')
    expect(co).toHaveLength(1)
    expect(co[0]!.first_entered_at).toBe(at(0)) // not the min-80 re-entry
    // Three crossing events happened (CO, WY, CO) but only two checklist rows exist.
    const events = await t.app.inject({
      method: 'GET',
      url: '/api/events?types=location.crossing.state',
      headers: asProfile(parent.id),
    })
    expect(events.json().events).toHaveLength(3)
    expect(states).toHaveLength(2)
  })
})

describe('leg summaries & trip summary', () => {
  let t: TestApp
  let parent: { id: string }
  let kid: { id: string }
  let d1: any
  let d2: any
  const D1 = LOVELAND_I25
  const D2 = FORT_COLLINS
  const gas = NEAR_LONGMONT
  const approach = offsetMeters(D1, -111, 0)
  const departed = offsetMeters(D1, 5560, 0)
  const route: LatLon[] = []

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
    kid = await t.addProfile('Sam', 'kid')

    const mk = async (name: string, pt: LatLon) => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/destinations',
        headers: asProfile(parent.id),
        payload: { name, lat: pt.lat, lon: pt.lon },
      })
      return res.json()
    }
    d1 = await mk('Loveland Rest', D1)
    d2 = await mk('Fort Collins', D2)

    // Two games finished during leg 0 (parent wins), one during leg 1 (kid wins).
    const game = async (winner: string, loser: string, min: number) =>
      appendEvent(t.db.pool, {
        type: 'game.finished',
        actorId: null,
        payload: {
          game_id: randomUUID(),
          game_type: 'checkers',
          result: 'win',
          winner_profile_id: winner,
          loser_profile_id: loser,
          move_count: 30,
        },
        clientTs: at(min),
      })
    await game(parent.id, kid.id, 10)
    await game(parent.id, kid.id, 20)
    await game(kid.id, parent.id, 70)

    const pings: Array<[LatLon, number]> = [
      [DENVER, 0],
      [{ lat: 40.0, lon: -104.99 }, 15],
      [gas, 30],
      [gas, 33], // stop opens, backdated to min 30
      [gas, 42],
      [{ lat: 40.3, lon: -104.99 }, 45], // closes: 15 min journal-worthy stop
      [approach, 50],
      [approach, 55], // stop opens at min 50 -> arrival at destination 1
      [departed, 70], // closes the layover: 20 min journal-worthy
      [D2, 90],
      [D2, 95], // stop opens at min 90 -> arrival at destination 2 (stop stays open)
    ]
    for (const [pt] of pings) route.push(pt)
    await syncPings(t, parent.id, pings.map(([pt, min]) => p(pt, min)))

    // Journal posts: two by the kid, one by the parent.
    for (const [who, text] of [
      [kid.id, 'longest drive everrr'],
      [kid.id, 'I won at checkers!'],
      [parent.id, 'made it to Fort Collins'],
    ] as const) {
      const res = await t.app.inject({ method: 'POST', url: '/api/journal', headers: asProfile(who), payload: { text } })
      expect(res.statusCode).toBe(201)
    }
  })
  afterAll(async () => await t.close())

  it('the leg summary carries wall/moving durations, miles, stop count, states, and games [LOC-009]', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/legs', headers: asProfile(parent.id) })
    const legs = res.json()
    expect(legs).toHaveLength(2)

    const leg0 = legs[0]
    expect(leg0.leg_index).toBe(0)
    expect(leg0.destination_id).toBe(d1.id)
    expect(leg0.destination_name).toBe('Loveland Rest')
    expect(leg0.started_at).toBe(at(0))
    expect(leg0.arrived_at).toBe(at(50))
    expect(leg0.summary.wall_minutes).toBeCloseTo(50, 6)
    expect(leg0.summary.moving_minutes).toBeCloseTo(35, 6) // 50 - 15 min gas stop
    expect(leg0.summary.stop_count).toBe(1)
    expect(leg0.summary.states).toEqual(['CO'])
    expect(leg0.summary.games_played).toBe(2)
    const leg0Ref = pathMiles(route.slice(0, 7))
    expect(leg0.summary.miles).toBeCloseTo(leg0Ref, 6)

    const leg1 = legs[1]
    expect(leg1.destination_id).toBe(d2.id)
    expect(leg1.started_at).toBe(at(50))
    expect(leg1.arrived_at).toBe(at(90))
    expect(leg1.summary.wall_minutes).toBeCloseTo(40, 6)
    // The layover at destination 1 (min 50-70) falls inside leg 1's window.
    expect(leg1.summary.moving_minutes).toBeCloseTo(20, 6)
    expect(leg1.summary.stop_count).toBe(1)
    expect(leg1.summary.games_played).toBe(1)
    const leg1Ref = pathMiles([approach, departed, D2])
    expect(leg1.summary.miles).toBeCloseTo(leg1Ref, 6)
  })

  it('lists completed legs and serves one by destination id [SUM-001]', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/api/legs', headers: asProfile(parent.id) })
    expect(list.json().map((l: any) => l.leg_index)).toEqual([0, 1])

    const one = await t.app.inject({ method: 'GET', url: `/api/legs/${d1.id}`, headers: asProfile(parent.id) })
    expect(one.statusCode).toBe(200)
    expect(one.json()).toEqual(list.json()[0])

    const missing = await t.app.inject({ method: 'GET', url: `/api/legs/${randomUUID()}`, headers: asProfile(parent.id) })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('not_found')
  })

  it('aggregates the whole trip from events [SUM-002]', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/trip/summary', headers: asProfile(parent.id) })
    expect(res.statusCode).toBe(200)
    const s = res.json()

    const reference = pathMiles(route)
    expect(Math.abs(s.miles - reference) / reference).toBeLessThan(0.005)
    expect(s.wall_minutes).toBeCloseTo(95, 6) // first ping min 0 -> last ping min 95
    expect(s.moving_minutes).toBeCloseTo(95 - 15 - 20, 6) // minus gas stop and layover
    expect(s.states_count).toBe(1)
    expect(s.stop_count).toBe(2) // the still-open arrival stop at D2 does not count yet
    expect(s.games_played).toBe(3)
    expect(s.wins_by_profile).toEqual({ [parent.id]: 2, [kid.id]: 1 })
    expect(s.journal_posts_by_profile).toEqual({ [kid.id]: 2, [parent.id]: 1 })
  })
})
