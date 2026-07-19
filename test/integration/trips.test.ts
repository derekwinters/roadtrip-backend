import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { appendEvent } from '../../src/events/store.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const iso = (ms: number) => new Date(ms).toISOString()

interface TripWire {
  id: string
  name: string
  status: 'active' | 'ended'
  started_at: string
  ended_at: string | null
}

async function startTrip(t: TestApp, profileId: string, name?: string) {
  return t.app.inject({
    method: 'POST',
    url: '/api/trips',
    headers: asProfile(profileId),
    payload: name ? { name } : {},
  })
}

async function endTrip(t: TestApp, profileId: string, tripId: string) {
  return t.app.inject({ method: 'POST', url: `/api/trips/${tripId}/end`, headers: asProfile(profileId) })
}

/** Syncs one journal.post with an explicit client_ts; returns the batch result. */
async function syncPost(t: TestApp, profileId: string, text: string, clientTs: string, eventId = randomUUID()) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sync/batch',
    headers: asProfile(profileId),
    payload: {
      device_id: 'trips-test',
      events: [{ event_id: eventId, type: 'journal.post', client_ts: clientTs, payload: { text } }],
    },
  })
  expect(res.statusCode).toBe(200)
  return { eventId, result: res.json().results[0] }
}

async function getJson(t: TestApp, profileId: string, url: string) {
  const res = await t.app.inject({ method: 'GET', url, headers: asProfile(profileId) })
  expect(res.statusCode).toBe(200)
  return res.json()
}

describe('trip lifecycle', () => {
  let t: TestApp
  let parent: { id: string }
  let kid: { id: string }
  let first: TripWire

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
    kid = await t.addProfile('Sam', 'kid')
  })
  afterAll(async () => await t.close())

  it('read models stay unscoped while no trips exist [TRIP-007]', async () => {
    expect(await getJson(t, kid.id, '/api/trips')).toEqual([])
    const posted = await t.app.inject({
      method: 'POST',
      url: '/api/journal',
      headers: asProfile(kid.id),
      payload: { text: 'pre-trip note' },
    })
    expect(posted.statusCode).toBe(201)
    const journal = await getJson(t, kid.id, '/api/journal')
    expect(journal.entries.map((e: any) => e.text)).toContain('pre-trip note')
    const summary = await getJson(t, kid.id, '/api/trip/summary')
    // Per-person breakdowns are no longer emitted (SUM-002); the unscoped summary still aggregates.
    expect(summary).not.toHaveProperty('journal_posts_by_profile')
    expect(summary).toHaveProperty('games_played')
  })

  it('starts a trip: parent-only, default name, 409 while one is active [TRIP-001]', async () => {
    const denied = await startTrip(t, kid.id)
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('parent_required')

    const res = await startTrip(t, parent.id)
    expect(res.statusCode).toBe(201)
    first = res.json()
    expect(first.status).toBe('active')
    expect(first.ended_at).toBeNull()
    expect(first.name).toBe(`Road Trip ${first.started_at.slice(0, 10)}`)

    const second = await startTrip(t, parent.id, 'Should conflict')
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('conflict')
  })

  it('ends a trip: parent-only, 409 for non-active, emits lifecycle events [TRIP-002]', async () => {
    await sleep(30) // give the trip window measurable width
    const denied = await endTrip(t, kid.id, first.id)
    expect(denied.statusCode).toBe(403)

    const res = await endTrip(t, parent.id, first.id)
    expect(res.statusCode).toBe(200)
    const ended = res.json()
    expect(ended.status).toBe('ended')
    expect(Date.parse(ended.ended_at)).toBeGreaterThan(Date.parse(first.started_at))

    expect((await endTrip(t, parent.id, first.id)).statusCode).toBe(409)
    expect((await endTrip(t, parent.id, randomUUID())).statusCode).toBe(404)

    const events = (await getJson(t, parent.id, '/api/events?types=trip.started,trip.ended')).events
    expect(events).toHaveLength(2)
    const [started, endedEv] = events
    expect(started.type).toBe('trip.started')
    expect(started.payload).toEqual({ trip_id: first.id, name: first.name })
    expect(started.client_ts).toBe(first.started_at)
    expect(endedEv.type).toBe('trip.ended')
    expect(endedEv.payload).toMatchObject({ trip_id: first.id, name: first.name })
    expect(typeof endedEv.payload.miles).toBe('number')
    expect(typeof endedEv.payload.states_count).toBe('number')
    // Both lifecycle events associate with their own trip window (TRIP-004).
    expect(started.trip_id).toBe(first.id)
    expect(endedEv.trip_id).toBe(first.id)
  })

  it('lists and renames trips [TRIP-003]', async () => {
    const res = await startTrip(t, parent.id, 'Beach Run')
    expect(res.statusCode).toBe(201)
    const beach = res.json()

    const list = await getJson(t, kid.id, '/api/trips')
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ id: first.id, status: 'ended' })
    expect(typeof list[0].started_at).toBe('string')
    expect(typeof list[0].ended_at).toBe('string')
    expect(list[1]).toMatchObject({ id: beach.id, name: 'Beach Run', status: 'active', ended_at: null })

    const denied = await t.app.inject({
      method: 'PATCH',
      url: `/api/trips/${beach.id}`,
      headers: asProfile(kid.id),
      payload: { name: 'Kid Takeover' },
    })
    expect(denied.statusCode).toBe(403)

    const renamed = await t.app.inject({
      method: 'PATCH',
      url: `/api/trips/${beach.id}`,
      headers: asProfile(parent.id),
      payload: { name: 'Beach Run II' },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().name).toBe('Beach Run II')
    const after = await getJson(t, kid.id, '/api/trips')
    expect(after.find((x: any) => x.id === beach.id).name).toBe('Beach Run II')

    const missing = await t.app.inject({
      method: 'PATCH',
      url: `/api/trips/${randomUUID()}`,
      headers: asProfile(parent.id),
      payload: { name: 'Ghost' },
    })
    expect(missing.statusCode).toBe(404)
  })
})

describe('event-to-trip association', () => {
  let t: TestApp
  let parent: { id: string }
  let kid: { id: string }
  let trip: TripWire
  let endedAt: string

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
    kid = await t.addProfile('Sam', 'kid')
    trip = (await startTrip(t, parent.id, 'Window Trip')).json()
    await sleep(80)
    endedAt = (await endTrip(t, parent.id, trip.id)).json().ended_at
  })
  afterAll(async () => await t.close())

  it('resolves trip_id from the [started_at, ended_at) window at insert, even after the trip ended [TRIP-004]', async () => {
    const startMs = Date.parse(trip.started_at)
    const endMs = Date.parse(endedAt)
    expect(endMs - startMs).toBeGreaterThanOrEqual(50)

    // All four posts sync AFTER the trip has ended — association follows client_ts.
    const inside = await syncPost(t, kid.id, 'inside the window', iso(Math.floor((startMs + endMs) / 2)))
    await syncPost(t, kid.id, 'at the start instant', trip.started_at)
    await syncPost(t, kid.id, 'before the trip', iso(startMs - 60_000))
    await syncPost(t, kid.id, 'at the end instant', endedAt)
    expect(inside.result.status).toBe('accepted')

    const events = (await getJson(t, kid.id, '/api/events?types=journal.post')).events
    const byText = Object.fromEntries(events.map((e: any) => [e.payload.text, e.trip_id]))
    expect(byText['inside the window']).toBe(trip.id)
    expect(byText['at the start instant']).toBe(trip.id) // started_at is inclusive
    expect(byText['before the trip']).toBeNull()
    expect(byText['at the end instant']).toBeNull() // ended_at is exclusive

    // Idempotent replays leave the stored event (and its association) untouched.
    const retry = await syncPost(t, kid.id, 'inside the window', iso(Math.floor((startMs + endMs) / 2)), inside.eventId)
    expect(retry.result.status).toBe('duplicate')
    const again = (await getJson(t, kid.id, '/api/events?types=journal.post')).events
    expect(again.filter((e: any) => e.payload.text === 'inside the window')).toHaveLength(1)
  })

  it('outside-window events stay readable unscoped but never appear in trip-scoped views [TRIP-010]', async () => {
    const unscoped = (await getJson(t, kid.id, '/api/events?types=journal.post')).events
    expect(unscoped.map((e: any) => e.payload.text).sort()).toEqual(
      ['at the end instant', 'at the start instant', 'before the trip', 'inside the window'].sort(),
    )

    const scoped = (await getJson(t, kid.id, `/api/journal?trip=${trip.id}`)).entries
    const texts = scoped.map((e: any) => e.text)
    expect(texts).toContain('inside the window')
    expect(texts).toContain('at the start instant')
    expect(texts).not.toContain('before the trip')
    expect(texts).not.toContain('at the end instant')

    // The default scope (most recently ended trip) applies the same exclusion.
    const dflt = (await getJson(t, kid.id, '/api/journal')).entries
    expect(dflt.map((e: any) => e.seq).sort()).toEqual(scoped.map((e: any) => e.seq).sort())
    const summary = await getJson(t, kid.id, '/api/trip/summary')
    // Per-person breakdowns are no longer emitted (SUM-002).
    expect(summary).not.toHaveProperty('journal_posts_by_profile')
  })
})

describe('destinations per trip', () => {
  let t: TestApp
  let parent: { id: string }

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
  })
  afterAll(async () => await t.close())

  const addDest = async (name: string) => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/destinations',
      headers: asProfile(parent.id),
      payload: { name, lat: 40, lon: -105 },
    })
    expect(res.statusCode).toBe(201)
    return res.json()
  }
  const listNames = async () => (await getJson(t, parent.id, '/api/destinations')).map((d: any) => d.name)
  const tripIdOf = async (id: string) =>
    (await t.db.pool.query('SELECT trip_id FROM destinations WHERE id = $1', [id])).rows[0].trip_id

  it('destinations belong to the trip active at creation; a new trip starts with an empty list [TRIP-005]', async () => {
    const home = await addDest('Home base')
    expect(await listNames()).toEqual(['Home base'])
    expect(await tripIdOf(home.id)).toBeNull()

    const tripA = (await startTrip(t, parent.id, 'Trip A')).json()
    expect(await listNames()).toEqual([]) // new trip: empty destination list

    const camp = await addDest('First camp')
    expect(await listNames()).toEqual(['First camp'])
    expect(await tripIdOf(camp.id)).toBe(tripA.id)

    await endTrip(t, parent.id, tripA.id)
    // Between trips: back to the unassociated pool; the past trip keeps its own list.
    expect(await listNames()).toEqual(['Home base'])
    expect(await tripIdOf(camp.id)).toBe(tripA.id)

    const tripB = (await startTrip(t, parent.id, 'Trip B')).json()
    expect(await listNames()).toEqual([])
    const cabin = await addDest('Cabin')
    expect(await listNames()).toEqual(['Cabin'])
    expect(await tripIdOf(cabin.id)).toBe(tripB.id)
  })
})

describe('trip-scoped read models & summaries', () => {
  let t: TestApp
  let parent: { id: string }
  let kid: { id: string }
  let tripA: TripWire
  let tripB: TripWire

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
    kid = await t.addProfile('Sam', 'kid')

    tripA = (await startTrip(t, parent.id, 'Trip A')).json()
    await sleep(60)
    const endedA = (await endTrip(t, parent.id, tripA.id)).json()
    await sleep(30)
    tripB = (await startTrip(t, parent.id, 'Trip B')).json()
    await sleep(60)
    const endedB = (await endTrip(t, parent.id, tripB.id)).json()

    const midOf = (start: string, end: string) => iso(Math.floor((Date.parse(start) + Date.parse(end)) / 2))
    const tsInA = midOf(tripA.started_at, endedA.ended_at)
    const tsInB = midOf(tripB.started_at, endedB.ended_at)
    const tsGap = midOf(endedA.ended_at, tripB.started_at)

    // Backdated derived events land in their trips via the association rule (TRIP-004).
    const seed = (type: string, payload: unknown, clientTs: string) =>
      appendEvent(t.db.pool, { type, payload, clientTs })
    await seed('location.crossing.state', { state: 'Colorado', state_code: 'CO', prev_state_code: null }, tsInA)
    await seed('location.crossing.state', { state: 'Colorado', state_code: 'CO', prev_state_code: null }, tsInB)
    await seed(
      'location.crossing.state',
      { state: 'Wyoming', state_code: 'WY', prev_state_code: 'CO' },
      iso(Date.parse(tsInB) + 5),
    )
    const game = (winner: string, loser: string, clientTs: string) =>
      seed(
        'game.finished',
        { game_id: randomUUID(), game_type: 'chess', result: 'win', winner_profile_id: winner, loser_profile_id: loser, move_count: 12 },
        clientTs,
      )
    await game(parent.id, kid.id, tsInA)
    await game(kid.id, parent.id, tsInB)

    await syncPost(t, kid.id, 'posted during A', tsInA)
    await syncPost(t, kid.id, 'posted during B', tsInB)
    await syncPost(t, kid.id, 'posted between trips', tsGap)
  })
  afterAll(async () => await t.close())

  it('journal/checklist/summary accept ?trip and default to active-else-most-recently-ended [TRIP-007]', async () => {
    const inA = (await getJson(t, kid.id, `/api/journal?trip=${tripA.id}`)).entries
    const textsA = inA.map((e: any) => e.text)
    expect(textsA).toContain('posted during A')
    expect(textsA).toContain('Road trip started: Trip A')
    expect(textsA).toContain('Crossed into Colorado')
    expect(textsA).not.toContain('posted during B')
    expect(textsA).not.toContain('posted between trips')

    const inB = (await getJson(t, kid.id, `/api/journal?trip=${tripB.id}`)).entries
    const textsB = inB.map((e: any) => e.text)
    expect(textsB).toContain('posted during B')
    expect(textsB).toContain('Crossed into Wyoming')
    expect(textsB).not.toContain('posted during A')
    expect(textsB).not.toContain('posted between trips')

    // No active trip: default scope is the most recently ended one (B).
    const dflt = (await getJson(t, kid.id, '/api/journal')).entries
    expect(dflt.map((e: any) => e.seq)).toEqual(inB.map((e: any) => e.seq))

    const listA = await getJson(t, kid.id, `/api/checklist?trip=${tripA.id}`)
    expect(listA.states.map((s: any) => s.state_code)).toEqual(['CO'])
    const listB = await getJson(t, kid.id, `/api/checklist?trip=${tripB.id}`)
    expect(listB.states.map((s: any) => s.state_code)).toEqual(['CO', 'WY'])
    expect(await getJson(t, kid.id, '/api/checklist')).toEqual(listB)

    // The trip parameter works on the default-summary route too.
    expect(await getJson(t, kid.id, `/api/trip/summary?trip=${tripA.id}`)).toEqual(
      await getJson(t, kid.id, `/api/trips/${tripA.id}/summary`),
    )
    expect(await getJson(t, kid.id, '/api/trip/summary')).toEqual(
      await getJson(t, kid.id, `/api/trips/${tripB.id}/summary`),
    )

    // Unknown trip ids are 404s, not silent empties.
    const missing = await t.app.inject({
      method: 'GET',
      url: `/api/journal?trip=${randomUUID()}`,
      headers: asProfile(kid.id),
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('not_found')
    const missingSummary = await t.app.inject({
      method: 'GET',
      url: `/api/trips/${randomUUID()}/summary`,
      headers: asProfile(kid.id),
    })
    expect(missingSummary.statusCode).toBe(404)

    // An active trip takes precedence over ended ones.
    const tripC = (await startTrip(t, parent.id, 'Trip C')).json()
    const dfltC = (await getJson(t, kid.id, '/api/journal')).entries
    expect(dfltC.map((e: any) => e.text)).toEqual(['Road trip started: Trip C'])
    await endTrip(t, parent.id, tripC.id)
  })

  it('per-trip summaries partition the stream with no double counting [TRIP-008]', async () => {
    const a = await getJson(t, kid.id, `/api/trips/${tripA.id}/summary`)
    const b = await getJson(t, kid.id, `/api/trips/${tripB.id}/summary`)

    expect(a.states_count).toBe(1)
    expect(a.games_played).toBe(1)
    // Per-person breakdowns are no longer computed or emitted (SUM-002).
    expect(a).not.toHaveProperty('wins_by_profile')
    expect(a).not.toHaveProperty('journal_posts_by_profile')

    expect(b.states_count).toBe(2)
    expect(b.games_played).toBe(1)
    expect(b).not.toHaveProperty('wins_by_profile')
    expect(b).not.toHaveProperty('journal_posts_by_profile')

    // Partition: scoped counts sum to the unscoped stream totals; the between-trips
    // post counts toward no trip at all.
    const allGames = (await getJson(t, kid.id, '/api/events?types=game.finished')).events
    expect(a.games_played + b.games_played).toBe(allGames.length)
    const allPosts = (await getJson(t, kid.id, '/api/events?types=journal.post')).events
    expect(allPosts).toHaveLength(3)
    expect(allPosts.filter((e: any) => e.trip_id === null).map((e: any) => e.payload.text)).toEqual([
      'posted between trips',
    ])
  })
})

describe('trip lifecycle journal & notifications', () => {
  let t: TestApp
  let parent: { id: string }
  let kid: { id: string }
  let trip: TripWire

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
    kid = await t.addProfile('Sam', 'kid')
    trip = (await startTrip(t, parent.id, 'Grand Canyon Run')).json()
    await sleep(30)
    await endTrip(t, parent.id, trip.id)
  })
  afterAll(async () => await t.close())

  it('trip start/end are journal-worthy and deep-link to the trip summary [TRIP-009]', async () => {
    const entries = (await getJson(t, kid.id, '/api/journal')).entries
    expect(entries).toHaveLength(2)

    const [endEntry, startEntry] = entries // newest first
    expect(startEntry).toMatchObject({
      kind: 'trip_start',
      text: 'Road trip started: Grand Canyon Run',
      link: { kind: 'trip_summary', trip_id: trip.id },
    })
    expect(startEntry.actor).toMatchObject({ id: parent.id, role: 'parent' })
    expect(endEntry.kind).toBe('trip_end')
    expect(endEntry.text).toBe('Road trip complete — 0 mi, 0 states')
    expect(endEntry.link).toEqual({ kind: 'trip_summary', trip_id: trip.id })
  })

  it('trip lifecycle events notify everyone except the acting parent [TRIP-009]', async () => {
    const kidItems = (await getJson(t, kid.id, '/api/notifications')).items
    const kidTexts = kidItems.filter((i: any) => i.kind === 'journal_activity').map((i: any) => i.text)
    expect(kidTexts).toContain('Road trip started: Grand Canyon Run')
    expect(kidTexts).toContain('Road trip complete — 0 mi, 0 states')
    const started = kidItems.find((i: any) => i.text === 'Road trip started: Grand Canyon Run')
    expect(started.link).toEqual({ kind: 'trip_summary', trip_id: trip.id })

    const parentItems = (await getJson(t, parent.id, '/api/notifications')).items
    expect(parentItems.map((i: any) => i.text)).not.toContain('Road trip started: Grand Canyon Run')
  })
})
