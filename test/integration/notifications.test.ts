import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { appendEvent } from '../../src/events/store.js'

let t: TestApp
let dad: { id: string }
let mom: { id: string }
let sam: { id: string }

beforeAll(async () => {
  t = await createTestApp()
  dad = await t.addProfile('Dad', 'parent')
  mom = await t.addProfile('Mom', 'parent')
  sam = await t.addProfile('Sam', 'kid')
})
afterAll(async () => await t.close())

async function poll(profileId: string, after = 0, extra = '') {
  const res = await t.app.inject({
    method: 'GET',
    url: `/api/notifications?after=${after}${extra}`,
    headers: asProfile(profileId),
  })
  expect(res.statusCode).toBe(200)
  return res.json() as { items: any[]; next_after: number }
}

/** Current end-of-stream cursor (last scanned seq). */
async function tip(): Promise<number> {
  const { rows } = await t.db.pool.query('SELECT COALESCE(MAX(seq), 0) AS max FROM events')
  return Number(rows[0].max)
}

describe('notifications feed', () => {
  it('a challenge inviting Sam notifies Sam only, with game id and seq [NOTIF-001] [NOTIF-002]', async () => {
    const gameId = randomUUID()
    const res = await appendEvent(t.db.pool, {
      type: 'game.created',
      payload: { game_id: gameId, game_type: 'chess', mode: 'challenge', invited_profile_id: sam.id, options: {} },
      clientTs: new Date(),
    })

    const forSam = await poll(sam.id)
    expect(forSam.items).toHaveLength(1)
    expect(forSam.items[0]).toMatchObject({ seq: res.seq, kind: 'challenge_received', game_id: gameId })
    expect(typeof forSam.items[0].text).toBe('string')
    expect(forSam.items[0].text.length).toBeGreaterThan(0)
    expect(forSam.next_after).toBe(res.seq)

    // Nobody else hears about it.
    expect((await poll(dad.id)).items).toHaveLength(0)
    expect((await poll(mom.id)).items).toHaveLength(0)

    // Advancing the cursor past it yields nothing, and next_after echoes the cursor [NOTIF-001].
    const again = await poll(sam.id, forSam.next_after)
    expect(again.items).toHaveLength(0)
    expect(again.next_after).toBe(forSam.next_after)
  })

  it('a journal post notifies every profile except the author [NOTIF-003]', async () => {
    const cursor = await tip()
    const posted = await t.app.inject({
      method: 'POST',
      url: '/api/journal',
      headers: asProfile(sam.id),
      payload: { text: 'License plate bingo: got Alaska!' },
    })
    expect(posted.statusCode).toBe(201)

    for (const other of [dad, mom]) {
      const res = await poll(other.id, cursor)
      expect(res.items).toHaveLength(1)
      expect(res.items[0].kind).toBe('journal_activity')
      expect(res.items[0].text).toContain('License plate bingo')
    }

    // The author gets no item, but the cursor still advances past the scanned event
    // so clients never re-scan non-matching events.
    const forSam = await poll(sam.id, cursor)
    expect(forSam.items).toHaveLength(0)
    expect(forSam.next_after).toBeGreaterThan(cursor)
    expect(forSam.next_after).toBe(await tip())
  })

  it('automatic journal events notify everyone; pings, moves, config and short stops never do [NOTIF-004]', async () => {
    const cursor = await tip()
    const gameId = randomUUID()
    const seed = (type: string, payload: unknown, actorId: string | null = null) =>
      appendEvent(t.db.pool, { type, payload, actorId, clientTs: new Date() })

    await seed('location.crossing.state', { state: 'Kansas', state_code: 'KS', prev_state_code: 'CO' })
    await seed('location.stop.ended', {
      stop_id: randomUUID(),
      lat: 39.26,
      lon: -103.69,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_min: 25,
      journal_worthy: true,
      place: 'Limon',
    })
    await seed('trip.leg.arrived', {
      destination_id: randomUUID(),
      destination_name: 'Twine Ball',
      summary: { wall_minutes: 60, moving_minutes: 50, miles: 40, stop_count: 1, states: ['KS'], games_played: 0 },
    })
    // A finished game renders in the journal feed but must NOT notify (only challenges do).
    await seed('game.finished', {
      game_id: gameId,
      game_type: 'chess',
      result: 'win',
      winner_profile_id: dad.id,
      loser_profile_id: sam.id,
      move_count: 24,
    })
    // Never notify:
    await seed('location.ping', { lat: 39.5, lon: -103.0 }, dad.id)
    await seed('game.move', { game_id: gameId, move_no: 1, move: 'e4' }, dad.id)
    await seed('config.updated', { changes: { stop_radius_m: 120 } }, dad.id)
    await seed('location.stop.ended', { stop_id: randomUUID(), lat: 1, lon: 2, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), duration_min: 3, journal_worthy: false, place: null })
    await seed('location.crossing.city', { city: 'Salina', state_code: 'KS' })

    const lastScanned = await tip()
    for (const p of [dad, mom, sam]) {
      const res = await poll(p.id, cursor)
      // Three automatic journal events notify; the game result does not.
      expect(res.items).toHaveLength(3)
      expect(res.items.every((i) => i.kind === 'journal_activity')).toBe(true)
      expect(res.items.some((i) => i.game_id === gameId)).toBe(false)
      // Cursor lands on the last scanned event, not the last matching one.
      expect(res.next_after).toBe(lastScanned)
    }
  })

  it('a game result never notifies, for actor or anyone else [NOTIF-004]', async () => {
    const cursor = await tip()
    await appendEvent(t.db.pool, {
      type: 'game.finished',
      actorId: sam.id,
      payload: { game_id: randomUUID(), game_type: 'checkers', result: 'win', winner_profile_id: sam.id, loser_profile_id: dad.id, move_count: 18 },
      clientTs: new Date(),
    })
    expect((await poll(sam.id, cursor)).items).toHaveLength(0)
    expect((await poll(dad.id, cursor)).items).toHaveLength(0)
    expect((await poll(mom.id, cursor)).items).toHaveLength(0)
  })

  it('long-polls with wait and wakes within seconds of a new event [NOTIF-005]', async () => {
    const cursor = await tip()
    const waiter = t.app.inject({
      method: 'GET',
      url: `/api/notifications?after=${cursor}&wait=10`,
      headers: asProfile(dad.id),
    })
    const started = Date.now()
    setTimeout(() => {
      void t.app.inject({
        method: 'POST',
        url: '/api/journal',
        headers: asProfile(sam.id),
        payload: { text: 'are we there yet?' },
      })
    }, 300)
    const res = await waiter
    expect(Date.now() - started).toBeLessThan(8000)
    const body = res.json()
    expect(body.items.some((i: any) => i.kind === 'journal_activity' && i.text.includes('are we there yet?'))).toBe(true)
    expect(body.next_after).toBeGreaterThan(cursor)
  })

  it('an exhausted wait returns an empty page with the cursor unchanged [NOTIF-005]', async () => {
    const cursor = await tip()
    const started = Date.now()
    const res = await poll(dad.id, cursor, '&wait=1')
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(res.items).toHaveLength(0)
    expect(res.next_after).toBe(cursor)
  })
})
