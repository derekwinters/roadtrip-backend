import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { seedConfigDefaults } from '../../src/config.js'
import { GAME_TYPES } from '../../src/games/registry.js'

/**
 * Family-wide enable/disable per game type: docs/spec/05-config.md CFG-010 and
 * docs/spec/08-games.md GAME-021 (create-time enforcement, `game_disabled`) and GAME-022
 * (existing games are unaffected).
 */

let t: TestApp
let dad: { id: string }
let sam: { id: string }

const ALL_ENABLED = Object.fromEntries(GAME_TYPES.map((type) => [`game_${type}_enabled`, true]))

beforeAll(async () => {
  t = await createTestApp()
  dad = await t.addProfile('Dad', 'parent')
  sam = await t.addProfile('Sam', 'kid')
})
afterAll(async () => await t.close())

async function getConfig(as: string) {
  return t.app.inject({ method: 'GET', url: '/api/config', headers: asProfile(as) })
}
async function putConfig(as: string, payload: unknown) {
  return t.app.inject({ method: 'PUT', url: '/api/config', headers: asProfile(as), payload: payload as object })
}
async function createGame(by: string, payload: Record<string, unknown>) {
  return t.app.inject({ method: 'POST', url: '/api/games', headers: asProfile(by), payload })
}
async function gameCreatedCount(): Promise<number> {
  const { rows } = await t.db.pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'game.created'`)
  return rows[0].n
}
async function gameRowCount(): Promise<number> {
  const { rows } = await t.db.pool.query('SELECT count(*)::int AS n FROM games')
  return rows[0].n
}

describe('game-type config keys [CFG-010]', () => {
  it('seeds every key as true on first boot and restores a deleted key on the next boot [CFG-010] [CFG-005]', async () => {
    const { rows } = await t.db.pool.query(`SELECT key, value FROM config WHERE key LIKE 'game\\_%\\_enabled'`)
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual(ALL_ENABLED)

    await t.db.pool.query(`DELETE FROM config WHERE key = 'game_chess_enabled'`)
    await seedConfigDefaults(t.db.pool) // what boot does (src/index.ts)
    const healed = await t.db.pool.query(`SELECT value FROM config WHERE key = 'game_chess_enabled'`)
    expect(healed.rows).toEqual([{ value: true }])
  })

  it('GET /api/config returns every key to any profile [CFG-010] [CFG-001]', async () => {
    for (const who of [sam.id, dad.id]) {
      const res = await getConfig(who)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject(ALL_ENABLED)
    }
  })

  it('a parent can toggle a key; a kid gets 403 parent_required [CFG-010] [CFG-002]', async () => {
    const kid = await putConfig(sam.id, { game_chess_enabled: false })
    expect(kid.statusCode).toBe(403)
    expect(kid.json().error.code).toBe('parent_required')
    expect((await getConfig(sam.id)).json().game_chess_enabled).toBe(true)

    const off = await putConfig(dad.id, { game_chess_enabled: false })
    expect(off.statusCode).toBe(200)
    expect(off.json().game_chess_enabled).toBe(false)
    expect((await getConfig(sam.id)).json().game_chess_enabled).toBe(false)

    const on = await putConfig(dad.id, { game_chess_enabled: true })
    expect(on.json().game_chess_enabled).toBe(true)
  })

  it('rejects non-boolean values 400 validation without applying any of the batch [CFG-010] [CFG-002]', async () => {
    for (const payload of [
      { game_hangman_enabled: 'false' },
      { game_ultimate_enabled: 0 },
      { game_checkers_enabled: false, game_tictactoe_enabled: 'nope' }, // all-or-nothing
      { game_fourinarow_enabled: false, stop_radius_m: 5 }, // all-or-nothing across key kinds
    ]) {
      const res = await putConfig(dad.id, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('validation')
    }
    expect((await getConfig(sam.id)).json()).toMatchObject(ALL_ENABLED)
  })

  it('toggling emits config.updated with exactly the changed keys [CFG-010] [CFG-003]', async () => {
    const res = await putConfig(dad.id, { game_ultimate_enabled: false, game_hangman_enabled: false })
    expect(res.statusCode).toBe(200)
    const events = await t.app.inject({ method: 'GET', url: '/api/events?types=config.updated', headers: asProfile(dad.id) })
    const last = events.json().events.at(-1)
    expect(last.payload.changes).toEqual({ game_ultimate_enabled: false, game_hangman_enabled: false })
    await putConfig(dad.id, { game_ultimate_enabled: true, game_hangman_enabled: true })
  })
})

describe('create-time enforcement [GAME-021]', () => {
  it('creating a disabled type gets 403 game_disabled and persists nothing; enabled types still create [GAME-021]', async () => {
    expect((await putConfig(dad.id, { game_checkers_enabled: false })).statusCode).toBe(200)
    const events = await gameCreatedCount()
    const rows = await gameRowCount()

    // Family-wide: kids and parents alike, open and challenge modes alike.
    for (const [by, payload] of [
      [sam.id, { game_type: 'checkers', mode: 'open' }],
      [dad.id, { game_type: 'checkers', mode: 'challenge', invited_profile_id: sam.id }],
    ] as const) {
      const res = await createGame(by, payload)
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe('game_disabled')
    }
    expect(await gameCreatedCount()).toBe(events)
    expect(await gameRowCount()).toBe(rows)

    const chess = await createGame(sam.id, { game_type: 'chess', mode: 'open' })
    expect(chess.statusCode).toBe(201)
    expect(await gameCreatedCount()).toBe(events + 1)

    // Re-enabling takes effect on the next create without a restart (CFG-003).
    expect((await putConfig(dad.id, { game_checkers_enabled: true })).statusCode).toBe(200)
    expect((await createGame(sam.id, { game_type: 'checkers', mode: 'open' })).statusCode).toBe(201)
  })
})

describe('existing games are unaffected [GAME-022]', () => {
  it('an active game of a type disabled after it started can move, be resigned, and be replayed [GAME-022]', async () => {
    const created = await createGame(dad.id, { game_type: 'tictactoe', mode: 'open' })
    expect(created.statusCode).toBe(201)
    const id = created.json().id
    expect((await t.app.inject({ method: 'POST', url: `/api/games/${id}/join`, headers: asProfile(sam.id) })).statusCode).toBe(200)

    expect((await putConfig(dad.id, { game_tictactoe_enabled: false })).statusCode).toBe(200)

    const mv = await t.app.inject({
      method: 'POST',
      url: `/api/games/${id}/moves`,
      headers: asProfile(dad.id),
      payload: { move: { cell: 4 } },
    })
    expect(mv.statusCode).toBe(200)
    expect(mv.json().move_count).toBe(1)

    const resign = await t.app.inject({ method: 'POST', url: `/api/games/${id}/resign`, headers: asProfile(sam.id) })
    expect(resign.statusCode).toBe(200)
    expect(resign.json()).toMatchObject({ status: 'finished', result: 'win', winner_id: dad.id })

    const read = await t.app.inject({ method: 'GET', url: `/api/games/${id}`, headers: asProfile(sam.id) })
    expect(read.statusCode).toBe(200)
    expect(read.json().status).toBe('finished')

    const replay = await t.app.inject({ method: 'GET', url: `/api/games/${id}/events`, headers: asProfile(sam.id) })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().events.map((e: any) => e.type)).toEqual(['game.created', 'game.joined', 'game.move', 'game.finished'])

    // Creation of the type stays blocked meanwhile (GAME-021).
    expect((await createGame(dad.id, { game_type: 'tictactoe', mode: 'open' })).statusCode).toBe(403)
    await putConfig(dad.id, { game_tictactoe_enabled: true })
  })
})
