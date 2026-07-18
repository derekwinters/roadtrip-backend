import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { buildScenario, toClientEvents, type Scenario } from '../../scripts/simulate-trip.js'
import { pathMiles } from '../../src/location/geo.js'

/**
 * TRIP-011: the simulator populates two API-driven trips with distinct histories.
 * Trip windows are real wall-clock intervals, so scenarios run with heavy time
 * compression (whole drive ≈ 2s of client_ts) and the test waits for the compressed
 * timeline to pass before ending each trip — every ping then falls inside its trip's
 * window exactly like a live drive.
 */
const COMPRESSION = 3600

/** Sleeps until the wall clock is past the given timestamp (plus a small margin). */
async function waitUntilPast(isoTs: string): Promise<void> {
  const delta = Date.parse(isoTs) + 100 - Date.now()
  if (delta > 0) await new Promise((r) => setTimeout(r, delta))
}

describe('multi-trip simulation', () => {
  let t: TestApp
  let parent: { id: string }
  let kid: { id: string }
  let tripA: any
  let tripB: any
  let scenA: Scenario
  let scenB: Scenario

  const getJson = async (url: string) => {
    const res = await t.app.inject({ method: 'GET', url, headers: asProfile(parent.id) })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  async function runScenario(scenario: Scenario): Promise<void> {
    for (const dest of scenario.destinations) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/destinations',
        headers: asProfile(parent.id),
        payload: dest,
      })
      expect(res.statusCode).toBe(201)
    }
    const events = toClientEvents(scenario.pings)
    for (let i = 0; i < events.length; i += 200) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: asProfile(parent.id),
        payload: { device_id: 'simulator', events: events.slice(i, i + 200) },
      })
      expect(res.statusCode).toBe(200)
      for (const r of res.json().results) expect(r.status).toBe('accepted')
    }
    await waitUntilPast(scenario.pings[scenario.pings.length - 1]!.ts)
  }

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
    kid = await t.addProfile('Sam', 'kid')

    // Trip A: the arrival scenario (Denver -> Fort Collins with a gas stop + arrival).
    tripA = (
      await t.app.inject({
        method: 'POST',
        url: '/api/trips',
        headers: asProfile(parent.id),
        payload: { name: 'Colorado Loop' },
      })
    ).json()
    scenA = buildScenario('arrival', {
      startTime: new Date(Date.parse(tripA.started_at) + 250).toISOString(),
      compression: COMPRESSION,
    })
    await runScenario(scenA)
    tripA = (
      await t.app.inject({ method: 'POST', url: `/api/trips/${tripA.id}/end`, headers: asProfile(parent.id) })
    ).json()

    // Between trips: a journal post that belongs to no trip (TRIP-010).
    const between = await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(kid.id),
      payload: {
        device_id: 'sam-tablet',
        events: [
          {
            event_id: randomUUID(),
            type: 'journal.post',
            client_ts: new Date().toISOString(),
            payload: { text: 'between trips' },
          },
        ],
      },
    })
    expect(between.json().results[0].status).toBe('accepted')

    // Trip B: the state-crossing scenario (Denver -> Cheyenne, CO -> WY).
    tripB = (
      await t.app.inject({
        method: 'POST',
        url: '/api/trips',
        headers: asProfile(parent.id),
        payload: { name: 'Wyoming Dash' },
      })
    ).json()
    scenB = buildScenario('state_crossing', {
      startTime: new Date(Date.parse(tripB.started_at) + 250).toISOString(),
      compression: COMPRESSION,
    })
    await runScenario(scenB)
  }, 120_000)
  afterAll(async () => await t.close())

  it('the simulator populates two trips with distinct journal histories [TRIP-011]', async () => {
    const trips = await getJson('/api/trips')
    expect(trips.map((x: any) => [x.name, x.status])).toEqual([
      ['Colorado Loop', 'ended'],
      ['Wyoming Dash', 'active'],
    ])

    const inA = (await getJson(`/api/journal?trip=${tripA.id}&limit=200`)).entries
    const kindsA = inA.map((e: any) => e.kind)
    expect(kindsA).toContain('trip_start')
    expect(kindsA).toContain('trip_end')
    expect(kindsA).toContain('leg_arrival')
    const textsA = inA.map((e: any) => e.text)
    expect(textsA).toContain('Road trip started: Colorado Loop')
    expect(textsA).not.toContain('between trips')
    expect(textsA).not.toContain('Crossed into Wyoming')

    const inB = (await getJson(`/api/journal?trip=${tripB.id}&limit=200`)).entries
    const textsB = inB.map((e: any) => e.text)
    expect(textsB).toContain('Road trip started: Wyoming Dash')
    expect(textsB).toContain('Crossed into Wyoming')
    expect(textsB).not.toContain('between trips')
    expect(inB.map((e: any) => e.kind)).not.toContain('leg_arrival')
  })

  it('checklist and legs isolate per trip [TRIP-011]', async () => {
    const listA = await getJson(`/api/checklist?trip=${tripA.id}`)
    expect(listA.states.map((s: any) => s.state_code)).toEqual(['CO'])
    expect(listA.cities.map((c: any) => c.city)).toContain('Fort Collins')
    const listB = await getJson(`/api/checklist?trip=${tripB.id}`)
    expect(listB.states.map((s: any) => s.state_code)).toEqual(['CO', 'WY'])
    expect(listB.cities.map((c: any) => c.city)).toContain('Cheyenne')
    expect(listB.cities.map((c: any) => c.city)).not.toContain('Fort Collins')

    const legsA = await getJson(`/api/legs?trip=${tripA.id}`)
    expect(legsA).toHaveLength(1)
    expect(legsA[0]).toMatchObject({ leg_index: 0, destination_name: 'Fort Collins' })
    expect(await getJson(`/api/legs?trip=${tripB.id}`)).toEqual([])
    // Active trip B is the default scope.
    expect(await getJson('/api/legs')).toEqual([])
  })

  it('per-trip summaries match the simulated reference mileage without double counting [TRIP-008] [TRIP-011]', async () => {
    const a = await getJson(`/api/trips/${tripA.id}/summary`)
    const refA = pathMiles(scenA.pings)
    expect(Math.abs(a.miles - refA) / refA).toBeLessThan(0.005)
    expect(a.states_count).toBe(1)

    const b = await getJson(`/api/trips/${tripB.id}/summary`)
    const refB = pathMiles(scenB.pings)
    expect(Math.abs(b.miles - refB) / refB).toBeLessThan(0.005)
    expect(b.states_count).toBe(2)

    // The between-trips post belongs to no trip: readable unscoped, counted nowhere.
    expect(a.journal_posts_by_profile).toEqual({})
    expect(b.journal_posts_by_profile).toEqual({})
    const posts = (await getJson('/api/events?types=journal.post')).events
    expect(posts).toHaveLength(1)
    expect(posts[0].trip_id).toBeNull()
  })

  it('default scope follows the active trip, then the most recently ended one [TRIP-007] [TRIP-011]', async () => {
    expect(await getJson('/api/trip/summary')).toEqual(await getJson(`/api/trips/${tripB.id}/summary`))
    const dfltJournal = (await getJson('/api/journal?limit=200')).entries
    const scopedB = (await getJson(`/api/journal?trip=${tripB.id}&limit=200`)).entries
    expect(dfltJournal.map((e: any) => e.seq)).toEqual(scopedB.map((e: any) => e.seq))

    const res = await t.app.inject({
      method: 'POST',
      url: `/api/trips/${tripB.id}/end`,
      headers: asProfile(parent.id),
    })
    expect(res.statusCode).toBe(200)

    // Ended, trip B is now the most recently ended trip — still the default scope.
    const after = (await getJson('/api/journal?limit=200')).entries
    expect(after.map((e: any) => e.text)).toContain('Road trip started: Wyoming Dash')
    expect(after.some((e: any) => e.kind === 'trip_end')).toBe(true)
    expect(await getJson('/api/trip/summary')).toEqual(await getJson(`/api/trips/${tripB.id}/summary`))
  })
})
