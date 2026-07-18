import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'

/**
 * SIM-008 — multi-client game day: two clients play a complete chess game through the
 * public API while a third client spectates by long-polling the game's event stream
 * (GAME-009 at scenario level). The spectator must observe every move, in order,
 * while the game is live — and the finish must land in the main event feed.
 */

let t: TestApp
let white: { id: string }
let black: { id: string }
let spectator: { id: string }

beforeAll(async () => {
  t = await createTestApp()
  white = await t.addProfile('White', 'parent')
  black = await t.addProfile('Black', 'kid')
  spectator = await t.addProfile('Backseat', 'kid')
})
afterAll(async () => await t.close())

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('multi-client spectated chess game', () => {
  it('two clients play a full chess game while a third long-polls and sees every move in order [SIM-008]', async () => {
    // Client 1 creates, client 2 joins.
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/games',
      headers: asProfile(white.id),
      payload: { game_type: 'chess', mode: 'open' },
    })
    expect(created.statusCode).toBe(201)
    const gameId = created.json().id
    const joined = await t.app.inject({
      method: 'POST',
      url: `/api/games/${gameId}/join`,
      headers: asProfile(black.id),
    })
    expect(joined.statusCode).toBe(200)

    // Client 3 spectates: long-poll loop over the game's event stream.
    const seen: Array<{ seq: number; type: string; payload: any }> = []
    const spectate = (async () => {
      let after = 0
      for (let i = 0; i < 60; i++) {
        const res = await t.app.inject({
          method: 'GET',
          url: `/api/games/${gameId}/events?after=${after}&wait=5`,
          headers: asProfile(spectator.id),
        })
        expect(res.statusCode).toBe(200)
        const { events, next_after } = res.json()
        seen.push(...events)
        after = next_after
        if (events.some((e: any) => e.type === 'game.finished')) return
      }
      throw new Error('spectator never saw game.finished')
    })()

    // A complete scripted game: scholar's mate, 7 plies, played live with the
    // spectator polling concurrently.
    const script: Array<[string, { from: string; to: string }]> = [
      [white.id, { from: 'e2', to: 'e4' }],
      [black.id, { from: 'e7', to: 'e5' }],
      [white.id, { from: 'f1', to: 'c4' }],
      [black.id, { from: 'b8', to: 'c6' }],
      [white.id, { from: 'd1', to: 'h5' }],
      [black.id, { from: 'g8', to: 'f6' }],
      [white.id, { from: 'h5', to: 'f7' }], // Qxf7# — checkmate
    ]
    for (const [by, move] of script) {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/games/${gameId}/moves`,
        headers: asProfile(by),
        payload: { move },
      })
      expect(res.statusCode, res.body).toBe(200)
      await sleep(25) // let the spectator's long-poll interleave with live play
    }

    await spectate

    // The spectator saw every move of the live game, in order (GAME-009).
    const seqs = seen.map((e) => e.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    const moves = seen.filter((e) => e.type === 'game.move')
    expect(moves.map((e) => e.payload.move_no)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(moves.map((e) => e.payload.move)).toEqual(script.map(([, m]) => m))
    expect(seen.filter((e) => e.type === 'game.joined')).toHaveLength(1)

    // The finish is visible to the spectator and in the main event feed.
    const finished = seen.find((e) => e.type === 'game.finished')
    expect(finished!.payload).toMatchObject({
      game_id: gameId,
      game_type: 'chess',
      result: 'win',
      winner_profile_id: white.id,
      loser_profile_id: black.id,
      move_count: 7,
    })
    const feed = await t.app.inject({
      method: 'GET',
      url: '/api/events?types=game.finished&limit=500',
      headers: asProfile(spectator.id),
    })
    expect(feed.json().events.some((e: any) => e.payload.game_id === gameId)).toBe(true)

    // Final server-side state agrees: checkmate, white won.
    const game = (
      await t.app.inject({ method: 'GET', url: `/api/games/${gameId}`, headers: asProfile(spectator.id) })
    ).json()
    expect(game).toMatchObject({ status: 'finished', result: 'win', winner_id: white.id, move_count: 7 })
  })
})
