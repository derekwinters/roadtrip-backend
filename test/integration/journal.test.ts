import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { appendEvent } from '../../src/events/store.js'

let t: TestApp
let parent: { id: string }
let kid: { id: string }

const GAME_WIN = randomUUID()
const GAME_DRAW = randomUUID()
const GAME_RESIGN = randomUUID()
const DEST_ID = randomUUID()

// Fixed, well-spaced client timestamps: the feed orders by client_ts (JRNL-002),
// so API posts made "now" (2026-07-18+) always sort above these.
const T = {
  stop: '2026-07-10T10:00:00.000Z',
  shortStop: '2026-07-10T10:30:00.000Z',
  crossing: '2026-07-10T11:00:00.000Z',
  backdated: '2026-07-10T11:30:00.000Z',
  arrival: '2026-07-10T12:00:00.000Z',
  win: '2026-07-10T13:00:00.000Z',
  draw: '2026-07-10T13:30:00.000Z',
  resign: '2026-07-10T13:45:00.000Z',
  noise: '2026-07-10T14:00:00.000Z',
}

beforeAll(async () => {
  t = await createTestApp()
  parent = await t.addProfile('Dad', 'parent')
  kid = await t.addProfile('Sam', 'kid')
})
afterAll(async () => await t.close())

async function feed(query = 'limit=200') {
  const res = await t.app.inject({ method: 'GET', url: `/api/journal?${query}`, headers: asProfile(kid.id) })
  expect(res.statusCode).toBe(200)
  return res
}

describe('journal feed', () => {
  it('kid posts publish instantly with no moderation state [JRNL-003] [PRO-006]', async () => {
    const posted = await t.app.inject({
      method: 'POST',
      url: '/api/journal',
      headers: asProfile(kid.id),
      payload: { text: 'Saw a dinosaur statue!' },
    })
    expect(posted.statusCode).toBe(201)
    expect(posted.json()).toMatchObject({
      kind: 'post',
      text: 'Saw a dinosaur statue!',
      actor: { id: kid.id, role: 'kid' },
    })

    // Immediately visible in the feed — no pending/moderation state anywhere.
    const res = await feed()
    const entries = res.json().entries
    expect(entries[0]).toMatchObject({ kind: 'post', text: 'Saw a dinosaur statue!' })
    expect(posted.body).not.toMatch(/moderat|pending|approv/i)
    expect(res.body).not.toMatch(/moderat|pending|approv/i)
  })

  it('returns exactly the journal-worthy events, rendered with deep links, noise excluded [JRNL-001] [JRNL-004] [JRNL-005]', async () => {
    // Seed derived events directly on the stream (the location/game engines are separate features).
    const seed = (type: string, payload: unknown, clientTs: string) =>
      appendEvent(t.db.pool, { type, payload, clientTs })

    await seed(
      'location.stop.ended',
      {
        stop_id: randomUUID(),
        lat: 39.26,
        lon: -103.69,
        started_at: '2026-07-10T09:37:00.000Z',
        ended_at: T.stop,
        duration_min: 23.4,
        journal_worthy: true,
        place: 'Limon',
      },
      T.stop,
    )
    await seed(
      'location.stop.ended',
      { stop_id: randomUUID(), lat: 39.3, lon: -103.5, started_at: T.shortStop, ended_at: T.shortStop, duration_min: 4, journal_worthy: false, place: null },
      T.shortStop,
    )
    await seed('location.crossing.state', { state: 'Kansas', state_code: 'KS', prev_state_code: 'CO' }, T.crossing)
    await seed(
      'trip.leg.arrived',
      {
        destination_id: DEST_ID,
        destination_name: 'Grandma',
        summary: { wall_minutes: 660, moving_minutes: 570, miles: 500.2, stop_count: 8, states: ['CO', 'KS'], games_played: 3 },
      },
      T.arrival,
    )
    await seed(
      'game.finished',
      { game_id: GAME_WIN, game_type: 'chess', result: 'win', winner_profile_id: parent.id, loser_profile_id: kid.id, move_count: 24 },
      T.win,
    )
    await seed(
      'game.finished',
      { game_id: GAME_DRAW, game_type: 'tictactoe', result: 'draw', winner_profile_id: parent.id, loser_profile_id: kid.id, move_count: 9 },
      T.draw,
    )
    await seed(
      'game.finished',
      { game_id: GAME_RESIGN, game_type: 'checkers', result: 'win', winner_profile_id: kid.id, loser_profile_id: parent.id, move_count: 10, resigned: true },
      T.resign,
    )
    // Noise: never journal-worthy (JRNL-004).
    await seed('location.ping', { lat: 39.5, lon: -103.0 }, T.noise)
    await seed('game.move', { game_id: GAME_WIN, move_no: 1, move: 'e4' }, T.noise)
    await seed('config.updated', { changes: { stop_radius_m: 120 } }, T.noise)
    await seed('location.stop.started', { stop_id: randomUUID(), lat: 1, lon: 2 }, T.noise)
    await seed('location.crossing.city', { city: 'Salina', state_code: 'KS' }, T.noise)

    const entries = (await feed()).json().entries
    // Exactly: 1 post (previous test) + stop + crossing + arrival + 3 game results.
    expect(entries).toHaveLength(7)
    expect(entries.map((e: any) => e.kind).sort()).toEqual(
      ['game_result', 'game_result', 'game_result', 'leg_arrival', 'post', 'state_crossing', 'stop'].sort(),
    )
    // Newest first.
    const ts = entries.map((e: any) => e.ts)
    expect([...ts].sort().reverse()).toEqual(ts)
    // The short stop and noise events never appear.
    expect(entries.some((e: any) => e.ts === T.shortStop)).toBe(false)

    const stop = entries.find((e: any) => e.kind === 'stop')
    expect(stop.text).toBe('Stopped for 23 min near Limon')
    expect(stop.link).toEqual({ kind: 'map_pin', lat: 39.26, lon: -103.69 })

    const crossing = entries.find((e: any) => e.kind === 'state_crossing')
    expect(crossing.text).toBe('Crossed into Kansas')
    expect(crossing.link).toEqual({ kind: 'checklist', state_code: 'KS' })

    const arrival = entries.find((e: any) => e.kind === 'leg_arrival')
    expect(arrival.text).toBe('Arrived at Grandma. 11.0 h in the car (9.5 h driving), 500 mi, 8 stops.')
    expect(arrival.link).toEqual({ kind: 'leg_summary', destination_id: DEST_ID })

    const win = entries.find((e: any) => e.ts === T.win)
    expect(win.link).toEqual({ kind: 'game_replay', game_id: GAME_WIN })

    const post = entries.find((e: any) => e.kind === 'post')
    expect(post.link).toBeUndefined()
  })

  it('renders game results from the game.finished payload plus profile names [JRNL-006]', async () => {
    const entries = (await feed()).json().entries
    expect(entries.find((e: any) => e.ts === T.win).text).toBe('Dad beat Sam in chess, 24 moves')
    expect(entries.find((e: any) => e.ts === T.draw).text).toBe('Dad and Sam drew in tictactoe after 9 moves')
    expect(entries.find((e: any) => e.ts === T.resign).text).toBe('Sam beat Dad in checkers (resigned)')
  })

  it('a backdated offline post syncs into its chronological place, not the top [JRNL-002] [JRNL-003]', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(kid.id),
      payload: {
        device_id: 'sam-tablet',
        events: [
          {
            event_id: randomUUID(),
            type: 'journal.post',
            client_ts: T.backdated,
            payload: { text: 'offline note from the car' },
          },
        ],
      },
    })
    expect(res.json().results[0].status).toBe('accepted')

    const entries = (await feed()).json().entries
    const texts = entries.map((e: any) => e.text)
    const idx = texts.indexOf('offline note from the car')
    // Highest seq in the stream, but ordered by client_ts: below the arrival, above the crossing.
    expect(idx).toBeGreaterThan(0)
    expect(entries[idx - 1].ts).toBe(T.arrival)
    expect(entries[idx + 1].ts).toBe(T.crossing)
    const ts = entries.map((e: any) => e.ts)
    expect([...ts].sort().reverse()).toEqual(ts)
  })

  it('paginates newest-first with before/limit and a next_before cursor [JRNL-001]', async () => {
    const all = (await feed()).json().entries
    expect(all).toHaveLength(8)

    const collected: any[] = []
    let before: number | null = null
    for (let guard = 0; guard < 10; guard++) {
      const res = await feed(`limit=3${before ? `&before=${before}` : ''}`)
      const body = res.json()
      collected.push(...body.entries)
      if (body.next_before === null || body.next_before === undefined) break
      before = body.next_before
    }
    expect(collected.map((e: any) => e.seq)).toEqual(all.map((e: any) => e.seq))
    const seqs = collected.map((e: any) => e.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('rejects blank and over-long posts [JRNL-003]', async () => {
    const blank = await t.app.inject({
      method: 'POST',
      url: '/api/journal',
      headers: asProfile(kid.id),
      payload: { text: '   ' },
    })
    expect(blank.statusCode).toBe(400)
    const long = await t.app.inject({
      method: 'POST',
      url: '/api/journal',
      headers: asProfile(kid.id),
      payload: { text: 'x'.repeat(2001) },
    })
    expect(long.statusCode).toBe(400)
  })
})
