import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { getEngine } from '../../src/games/registry.js'
import type { GameEngine } from '../../src/games/types.js'

/**
 * GAME-006 — replay determinism: for every game type, fold the finished game's event
 * stream from scratch through the engine and require deep equality with the state the
 * server cached in games.state while playing.
 */

let t: TestApp
let creator: { id: string }
let joiner: { id: string }

beforeAll(async () => {
  t = await createTestApp()
  creator = await t.addProfile('Creator', 'parent')
  joiner = await t.addProfile('Joiner', 'kid')
})
afterAll(async () => await t.close())

async function playGame(
  gameType: string,
  options: Record<string, unknown> | undefined,
  moves: Array<[string, unknown]>,
  opts: { resignBy?: string } = {},
): Promise<string> {
  const created = await t.app.inject({
    method: 'POST',
    url: '/api/games',
    headers: asProfile(creator.id),
    payload: { game_type: gameType, mode: 'open', ...(options ? { options } : {}) },
  })
  expect(created.statusCode).toBe(201)
  const id = created.json().id
  expect((await t.app.inject({ method: 'POST', url: `/api/games/${id}/join`, headers: asProfile(joiner.id) })).statusCode).toBe(200)
  for (const [by, move] of moves) {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/games/${id}/moves`,
      headers: asProfile(by),
      payload: { move },
    })
    expect(res.statusCode, res.body).toBe(200)
  }
  if (opts.resignBy) {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/games/${id}/resign`,
      headers: asProfile(opts.resignBy),
    })
    expect(res.statusCode).toBe(200)
  }
  return id
}

/** Folds the game's event stream from scratch and asserts equality with the cached state. */
async function assertReplayMatches(id: string): Promise<void> {
  const { rows } = await t.db.pool.query('SELECT status, state, game_type FROM games WHERE id = $1', [id])
  expect(rows[0].status).toBe('finished')

  const res = await t.app.inject({
    method: 'GET',
    url: `/api/games/${id}/events`,
    headers: asProfile(creator.id),
  })
  const events = res.json().events as Array<{ type: string; actor_id: string; payload: any }>
  const createdEv = events.find((e) => e.type === 'game.created')!
  const joinedEv = events.find((e) => e.type === 'game.joined')!
  const engine = getEngine(createdEv.payload.game_type) as GameEngine<unknown, unknown>

  let state = engine.init(createdEv.payload.options, [createdEv.actor_id, joinedEv.payload.profile_id])
  const moveEvents = events.filter((e) => e.type === 'game.move')
  moveEvents.forEach((e, i) => expect(e.payload.move_no).toBe(i + 1))
  for (const e of moveEvents) state = engine.apply(state, e.actor_id, e.payload.move)

  // JSON round-trip the fold so it is byte-comparable with the jsonb-cached state.
  expect(JSON.parse(JSON.stringify(state))).toEqual(rows[0].state)
}

describe('replay determinism (pure fold) per game type', () => {
  it("chess: replaying a finished game's events reproduces the cached state [GAME-006]", async () => {
    const mv = (from: string, to: string) => ({ from, to })
    const id = await playGame('chess', undefined, [
      [creator.id, mv('e2', 'e4')],
      [joiner.id, mv('e7', 'e5')],
      [creator.id, mv('f1', 'c4')],
      [joiner.id, mv('b8', 'c6')],
      [creator.id, mv('d1', 'h5')],
      [joiner.id, mv('g8', 'f6')],
      [creator.id, mv('h5', 'f7')], // scholar's mate
    ])
    await assertReplayMatches(id)
  })

  it("checkers: replaying a finished game's events reproduces the cached state [GAME-006]", async () => {
    const id = await playGame(
      'checkers',
      undefined,
      [
        [creator.id, { from: 'a3', to: 'b4' }],
        [joiner.id, { from: 'd6', to: 'c5' }],
        [creator.id, { from: 'b4', to: 'd6' }], // forced capture (jumps c5)
        [joiner.id, { from: 'c7', to: 'e5' }], // forced recapture (jumps d6)
      ],
      { resignBy: creator.id },
    )
    await assertReplayMatches(id)
  })

  it("tic-tac-toe: replaying a finished game's events reproduces the cached state [GAME-006]", async () => {
    const id = await playGame('tictactoe', undefined, [
      [creator.id, { cell: 0 }],
      [joiner.id, { cell: 3 }],
      [creator.id, { cell: 1 }],
      [joiner.id, { cell: 4 }],
      [creator.id, { cell: 2 }],
    ])
    await assertReplayMatches(id)
  })

  it("ultimate: replaying a finished game's events reproduces the cached state [GAME-006]", async () => {
    const id = await playGame(
      'ultimate',
      undefined,
      [
        [creator.id, { board: 4, cell: 4 }],
        [joiner.id, { board: 4, cell: 0 }],
        [creator.id, { board: 0, cell: 4 }],
        [joiner.id, { board: 4, cell: 8 }],
        [creator.id, { board: 8, cell: 4 }],
        [joiner.id, { board: 4, cell: 2 }],
      ],
      { resignBy: joiner.id },
    )
    await assertReplayMatches(id)
  })

  it("hangman: replaying a finished game's events reproduces the cached state [GAME-006]", async () => {
    const id = await playGame('hangman', { word: 'banana' }, [
      [joiner.id, { letter: 'z' }], // one wrong guess for wrong-count coverage
      [joiner.id, { letter: 'b' }],
      [joiner.id, { letter: 'a' }],
      [joiner.id, { letter: 'n' }],
    ])
    await assertReplayMatches(id)
  })
})
