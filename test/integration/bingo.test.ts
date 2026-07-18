import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'

/**
 * License Plate Bingo (docs/spec/14-bingo.md, BNG-001..005) driven through the public
 * API: sync-batch uploads of plate.* events and the /api/bingo read model.
 */

describe('license plate bingo', () => {
  let t: TestApp
  let dad: { id: string }
  let sam: { id: string }
  let alex: { id: string }
  let trip: any
  let base: number

  const ts = (n: number) => new Date(base + n * 1000).toISOString()

  const syncPlate = async (
    profileId: string,
    type: 'plate.spotted' | 'plate.unspotted',
    stateCode: unknown,
    clientTs: string,
    eventId = randomUUID(),
  ) => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(profileId),
      payload: {
        device_id: 'bingo-test',
        events: [{ event_id: eventId, type, client_ts: clientTs, payload: { state_code: stateCode } }],
      },
    })
    expect(res.statusCode).toBe(200)
    return { eventId, result: res.json().results[0] }
  }

  const getJson = async (profileId: string, url: string) => {
    const res = await t.app.inject({ method: 'GET', url, headers: asProfile(profileId) })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  beforeAll(async () => {
    t = await createTestApp()
    dad = await t.addProfile('Dad', 'parent')
    sam = await t.addProfile('Sam', 'kid')
    alex = await t.addProfile('Alex', 'kid')
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/trips',
      headers: asProfile(dad.id),
      payload: { name: 'Plate Run' },
    })
    expect(res.statusCode).toBe(201)
    trip = res.json()
    base = Date.parse(trip.started_at)
  })
  afterAll(async () => await t.close())

  it('accepts plate events from any profile with real timestamps; bad codes are rejected [BNG-001]', async () => {
    const spot = await syncPlate(sam.id, 'plate.spotted', 'CO', ts(10))
    expect(spot.result.status).toBe('accepted')
    expect((await syncPlate(alex.id, 'plate.spotted', 'WY', ts(20))).result.status).toBe('accepted')
    expect((await syncPlate(dad.id, 'plate.spotted', 'TX', ts(30))).result.status).toBe('accepted')
    expect((await syncPlate(alex.id, 'plate.spotted', 'DC', ts(40))).result.status).toBe('accepted')

    // Idempotent offline retry.
    const retry = await syncPlate(sam.id, 'plate.spotted', 'CO', ts(10), spot.eventId)
    expect(retry.result.status).toBe('duplicate')

    // Invalid codes are rejected per-event, never stored.
    for (const bad of ['ZZ', 'co', 'COL', 42, null]) {
      const res = await syncPlate(sam.id, 'plate.spotted', bad, ts(50))
      expect(res.result.status).toBe('rejected')
    }
    expect((await syncPlate(sam.id, 'plate.unspotted', 'XX', ts(50))).result.status).toBe('rejected')

    // Stored with their real client timestamps (offline queue semantics).
    const events = (await getJson(sam.id, '/api/events?types=plate.spotted')).events
    expect(events).toHaveLength(4)
    const byCode = Object.fromEntries(events.map((e: any) => [e.payload.state_code, e]))
    expect(byCode.CO.client_ts).toBe(ts(10))
    expect(byCode.CO.actor_id).toBe(sam.id)
    expect(byCode.DC.actor_id).toBe(alex.id)
  })

  it('folds the card per state in client_ts order, idempotently [BNG-002]', async () => {
    // A later duplicate spot never steals the credit.
    expect((await syncPlate(alex.id, 'plate.spotted', 'CO', ts(50))).result.status).toBe('accepted')
    let card = await getJson(sam.id, '/api/bingo')
    expect(card.cells.map((c: any) => [c.state_code, c.spotted_by])).toEqual([
      ['CO', sam.id],
      ['DC', alex.id],
      ['TX', dad.id],
      ['WY', alex.id],
    ])
    expect(card.counts).toEqual({ [sam.id]: 1, [alex.id]: 2, [dad.id]: 1 })

    // Removed then respotted: the respotter gets the credit.
    expect((await syncPlate(alex.id, 'plate.unspotted', 'WY', ts(60))).result.status).toBe('accepted')
    expect((await syncPlate(sam.id, 'plate.spotted', 'WY', ts(70))).result.status).toBe('accepted')
    // Unspotting a state nobody spotted is a stored no-op.
    expect((await syncPlate(sam.id, 'plate.unspotted', 'MT', ts(80))).result.status).toBe('accepted')

    card = await getJson(sam.id, '/api/bingo')
    const wy = card.cells.find((c: any) => c.state_code === 'WY')
    expect(wy).toMatchObject({ spotted_by: sam.id, spotted_by_name: 'Sam', spotted_at: ts(70) })
    expect(card.cells.map((c: any) => c.state_code)).toEqual(['CO', 'DC', 'TX', 'WY'])
    expect(card.counts).toEqual({ [sam.id]: 2, [alex.id]: 1, [dad.id]: 1 })

    // Out-of-order sync: the removal arrives first but carries the LATER timestamp.
    expect((await syncPlate(sam.id, 'plate.unspotted', 'NE', ts(100))).result.status).toBe('accepted')
    expect((await syncPlate(sam.id, 'plate.spotted', 'NE', ts(90))).result.status).toBe('accepted')
    card = await getJson(sam.id, '/api/bingo')
    expect(card.cells.map((c: any) => c.state_code)).toEqual(['CO', 'DC', 'TX', 'WY']) // NE folded spot->unspot
    const neLog = card.log.filter((l: any) => l.state_code === 'NE')
    expect(neLog.map((l: any) => [l.action, l.ts])).toEqual([
      ['spotted', ts(90)],
      ['unspotted', ts(100)],
    ])
  })

  it('honors removals only from the original spotter or a parent [BNG-003]', async () => {
    // Alex (kid, not the spotter) tries to clear Sam's CO: stored but ignored by the fold.
    expect((await syncPlate(alex.id, 'plate.unspotted', 'CO', ts(110))).result.status).toBe('accepted')
    let card = await getJson(sam.id, '/api/bingo')
    expect(card.cells.find((c: any) => c.state_code === 'CO')).toMatchObject({ spotted_by: sam.id })
    expect(card.log.filter((l: any) => l.state_code === 'CO' && l.action === 'unspotted')).toEqual([])

    // A parent's removal sticks.
    expect((await syncPlate(dad.id, 'plate.unspotted', 'CO', ts(120))).result.status).toBe('accepted')
    card = await getJson(sam.id, '/api/bingo')
    expect(card.cells.map((c: any) => c.state_code)).toEqual(['DC', 'TX', 'WY'])
    expect(card.log.filter((l: any) => l.state_code === 'CO' && l.action === 'unspotted')).toMatchObject([
      { actor_id: dad.id, actor_name: 'Dad', ts: ts(120) },
    ])

    // The ignored removal is still in the event stream (append-only).
    const removals = (await getJson(sam.id, '/api/events?types=plate.unspotted')).events
    expect(removals.filter((e: any) => e.payload.state_code === 'CO').map((e: any) => e.actor_id)).toEqual([
      alex.id,
      dad.id,
    ])
  })

  it('serves cells, effective log, and standing counts scoped per trip [BNG-004]', async () => {
    const dflt = await getJson(alex.id, '/api/bingo')
    const scoped = await getJson(alex.id, `/api/bingo?trip=${trip.id}`)
    expect(scoped).toEqual(dflt) // default scope is the active trip

    expect(dflt.cells).toEqual([
      { state_code: 'DC', spotted_by: alex.id, spotted_by_name: 'Alex', spotted_at: ts(40) },
      { state_code: 'TX', spotted_by: dad.id, spotted_by_name: 'Dad', spotted_at: ts(30) },
      { state_code: 'WY', spotted_by: sam.id, spotted_by_name: 'Sam', spotted_at: ts(70) },
    ])
    expect(dflt.counts).toEqual({ [sam.id]: 1, [alex.id]: 1, [dad.id]: 1 })
    // The log is chronological and carries actor + timestamp for spots AND removals.
    const tsList = dflt.log.map((l: any) => Date.parse(l.ts))
    expect(tsList).toEqual([...tsList].sort((a: number, b: number) => a - b))
    for (const item of dflt.log) {
      expect(item).toMatchObject({
        seq: expect.any(Number),
        action: expect.stringMatching(/^(spotted|unspotted)$/),
        state_code: expect.any(String),
        actor_id: expect.any(String),
        ts: expect.any(String),
      })
    }
    expect(dflt.log.filter((l: any) => l.action === 'unspotted').length).toBeGreaterThan(0)

    const missing = await t.app.inject({
      method: 'GET',
      url: `/api/bingo?trip=${randomUUID()}`,
      headers: asProfile(sam.id),
    })
    expect(missing.statusCode).toBe(404)
  })

  it('produces no journal entries and no notifications [BNG-005]', async () => {
    // The journal whitelist ignores plate.* events entirely.
    const journal = await getJson(sam.id, '/api/journal?limit=200')
    expect(journal.entries).toHaveLength(1)
    expect(journal.entries[0].kind).toBe('trip_start')

    // Notification derivation ignores them too: everyone still only sees the trip start.
    const samItems = (await getJson(sam.id, '/api/notifications')).items
    expect(samItems.map((i: any) => [i.kind, i.text])).toEqual([
      ['journal_activity', 'Road trip started: Plate Run'],
    ])
    const dadItems = (await getJson(dad.id, '/api/notifications')).items
    expect(dadItems).toEqual([]) // dad started the trip; plates never notify anyone
  })
})
