import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'

let t: TestApp
let dad: { id: string }
let sam: { id: string }
let alex: { id: string }

beforeAll(async () => {
  t = await createTestApp()
  dad = await t.addProfile('Dad', 'parent')
  sam = await t.addProfile('Sam', 'kid')
  alex = await t.addProfile('Alex', 'kid')
})
afterAll(async () => await t.close())

async function createGame(by: string, payload: Record<string, unknown>) {
  return t.app.inject({ method: 'POST', url: '/api/games', headers: asProfile(by), payload })
}
async function join(by: string, id: string) {
  return t.app.inject({ method: 'POST', url: `/api/games/${id}/join`, headers: asProfile(by) })
}
async function move(by: string, id: string, mv: unknown) {
  return t.app.inject({ method: 'POST', url: `/api/games/${id}/moves`, headers: asProfile(by), payload: { move: mv } })
}
async function gameEvents(id: string, viewer: string) {
  const res = await t.app.inject({ method: 'GET', url: `/api/games/${id}/events`, headers: asProfile(viewer) })
  return res.json() as { events: any[]; next_after: number }
}
/** Creates and activates a tic-tac-toe game between dad (X) and sam (O). */
async function activeTtt(): Promise<string> {
  const created = await createGame(dad.id, { game_type: 'tictactoe', mode: 'open' })
  expect(created.statusCode).toBe(201)
  const id = created.json().id
  expect((await join(sam.id, id)).statusCode).toBe(200)
  return id
}

describe('game lifecycle', () => {
  it('creating emits game.created and open games appear in the lobby [GAME-001]', async () => {
    const created = await createGame(dad.id, { game_type: 'tictactoe', mode: 'open' })
    expect(created.statusCode).toBe(201)
    const game = created.json()
    expect(game).toMatchObject({ game_type: 'tictactoe', mode: 'open', status: 'open', created_by: dad.id })

    const lobby = await t.app.inject({ method: 'GET', url: '/api/games?status=open', headers: asProfile(alex.id) })
    expect(lobby.statusCode).toBe(200)
    expect(lobby.json().map((g: any) => g.id)).toContain(game.id)

    const events = await t.app.inject({
      method: 'GET',
      url: '/api/events?types=game.created',
      headers: asProfile(dad.id),
    })
    const ev = events.json().events.find((e: any) => e.payload.game_id === game.id)
    expect(ev).toBeTruthy()
    expect(ev.payload).toMatchObject({ game_type: 'tictactoe', mode: 'open' })

    // mode=challenge requires invited_profile_id.
    const noInvite = await createGame(dad.id, { game_type: 'tictactoe', mode: 'challenge' })
    expect(noInvite.statusCode).toBe(400)
    expect(noInvite.json().error.code).toBe('validation')
  })

  it('lists filter by profile involvement [GAME-001]', async () => {
    const created = await createGame(dad.id, { game_type: 'checkers', mode: 'open' })
    const id = created.json().id
    await join(sam.id, id)
    const bySam = await t.app.inject({
      method: 'GET',
      url: `/api/games?profile=${sam.id}&status=active`,
      headers: asProfile(sam.id),
    })
    expect(bySam.json().map((g: any) => g.id)).toContain(id)
    const byAlex = await t.app.inject({
      method: 'GET',
      url: `/api/games?profile=${alex.id}&status=active`,
      headers: asProfile(alex.id),
    })
    expect(byAlex.json().map((g: any) => g.id)).not.toContain(id)
  })

  it('only the invited profile can join a challenge; creators cannot join their own game [GAME-002]', async () => {
    const created = await createGame(dad.id, {
      game_type: 'tictactoe',
      mode: 'challenge',
      invited_profile_id: sam.id,
    })
    expect(created.statusCode).toBe(201)
    const id = created.json().id

    const intruder = await join(alex.id, id)
    expect(intruder.statusCode).toBe(403)
    expect(intruder.json().error.code).toBe('not_invited')

    const self = await join(dad.id, id)
    expect(self.statusCode).toBeGreaterThanOrEqual(400)
    expect(self.statusCode).toBeLessThan(500)

    const invited = await join(sam.id, id)
    expect(invited.statusCode).toBe(200)
    expect(invited.json().status).toBe('active')
  })

  it('joining emits game.joined and activates; a third join gets 409 [GAME-003]', async () => {
    const created = await createGame(dad.id, { game_type: 'tictactoe', mode: 'open' })
    const id = created.json().id
    const joined = await join(sam.id, id)
    expect(joined.statusCode).toBe(200)
    expect(joined.json()).toMatchObject({ status: 'active', opponent_id: sam.id })

    const { events } = await gameEvents(id, alex.id)
    expect(events.some((e: any) => e.type === 'game.joined' && e.payload.profile_id === sam.id)).toBe(true)

    const third = await join(alex.id, id)
    expect(third.statusCode).toBe(409)
    expect(third.json().error.code).toBe('game_full')
  })

  it('unknown games return 404 with the error envelope', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/games/${randomUUID()}`,
      headers: asProfile(dad.id),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })
})

describe('moves', () => {
  it('illegal moves get 400 with the engine reason and persist no event [GAME-004]', async () => {
    const id = await activeTtt()
    const before = (await gameEvents(id, alex.id)).events.filter((e) => e.type === 'game.move').length

    const outOfRange = await move(dad.id, id, { cell: 99 })
    expect(outOfRange.statusCode).toBe(400)
    expect(outOfRange.json().error.code).toBe('illegal_move')
    expect(outOfRange.json().error.message.length).toBeGreaterThan(0)

    expect((await move(dad.id, id, { cell: 4 })).statusCode).toBe(200)

    const taken = await move(sam.id, id, { cell: 4 })
    expect(taken.statusCode).toBe(400)
    expect(taken.json().error.code).toBe('illegal_move')
    expect(taken.json().error.message).toMatch(/taken/i)

    const after = (await gameEvents(id, alex.id)).events.filter((e) => e.type === 'game.move').length
    expect(after).toBe(before + 1) // only the legal move persisted
  })

  it('out-of-turn, non-player and non-active moves are rejected without events [GAME-005]', async () => {
    const id = await activeTtt()

    const outOfTurn = await move(sam.id, id, { cell: 0 }) // creator (X) moves first
    expect(outOfTurn.statusCode).toBe(409)
    expect(outOfTurn.json().error.code).toBe('not_your_turn')

    const spectator = await move(alex.id, id, { cell: 0 })
    expect(spectator.statusCode).toBe(403)

    const open = await createGame(dad.id, { game_type: 'tictactoe', mode: 'open' })
    const notActive = await move(dad.id, open.json().id, { cell: 0 })
    expect(notActive.statusCode).toBe(409)

    expect((await gameEvents(id, alex.id)).events.filter((e) => e.type === 'game.move')).toHaveLength(0)
    expect((await gameEvents(open.json().id, alex.id)).events.filter((e) => e.type === 'game.move')).toHaveLength(0)
  })

  it('win detection finishes the game and emits game.finished with the full result [GAME-007]', async () => {
    const id = await activeTtt()
    const script: Array<[string, number]> = [
      [dad.id, 0],
      [sam.id, 3],
      [dad.id, 1],
      [sam.id, 4],
      [dad.id, 2], // X wins the top row
    ]
    let last: any
    for (const [by, cell] of script) {
      const res = await move(by, id, { cell })
      expect(res.statusCode).toBe(200)
      last = res.json()
    }
    expect(last).toMatchObject({ status: 'finished', result: 'win', winner_id: dad.id, move_count: 5, turn: null })

    const { events } = await gameEvents(id, alex.id)
    const finished = events.find((e) => e.type === 'game.finished')
    expect(finished.payload).toMatchObject({
      game_id: id,
      game_type: 'tictactoe',
      result: 'win',
      winner_profile_id: dad.id,
      loser_profile_id: sam.id,
      move_count: 5,
    })
    // The journal read model consumes game.finished (auto journal post, JRNL side);
    // game_id above is what its deep link keys on.

    const noMore = await move(sam.id, id, { cell: 8 })
    expect(noMore.statusCode).toBe(409)
  })

  it('draw detection finishes the game with result draw [GAME-007] [GAME-017]', async () => {
    const id = await activeTtt()
    const cells = [0, 4, 8, 1, 7, 6, 2, 5, 3] // full board, no winner
    for (let i = 0; i < cells.length; i++) {
      const by = i % 2 === 0 ? dad.id : sam.id
      expect((await move(by, id, { cell: cells[i] })).statusCode).toBe(200)
    }
    const { events } = await gameEvents(id, alex.id)
    const finished = events.find((e) => e.type === 'game.finished')
    expect(finished.payload).toMatchObject({ result: 'draw', move_count: 9 })
    expect(finished.payload.winner_profile_id).toBeUndefined()
  })

  it('checkers accepts algebraic moves and records captured squares in game.move [GAME-011]', async () => {
    const created = await createGame(dad.id, { game_type: 'checkers', mode: 'open' })
    const id = created.json().id
    expect((await join(sam.id, id)).statusCode).toBe(200)

    expect((await move(dad.id, id, { from: 'b3', to: 'c4' })).statusCode).toBe(200)
    expect((await move(sam.id, id, { from: 'e6', to: 'd5' })).statusCode).toBe(200)
    // c4 jumps the man on d5 to land on e6 — a forced capture.
    expect((await move(dad.id, id, { from: 'c4', to: 'e6' })).statusCode).toBe(200)

    const moves = (await gameEvents(id, alex.id)).events.filter((e) => e.type === 'game.move')
    expect(moves.map((e) => e.payload.move)).toEqual([
      { from: 'b3', to: 'c4' },
      { from: 'e6', to: 'd5' },
      { from: 'c4', to: 'e6', captured: ['d5'] },
    ])
  })
})

describe('views and streams', () => {
  it('GET /api/games/{id} returns the engine view with turn and players [GAME-008]', async () => {
    const id = await activeTtt()
    await move(dad.id, id, { cell: 4 })
    const res = await t.app.inject({ method: 'GET', url: `/api/games/${id}`, headers: asProfile(alex.id) })
    expect(res.statusCode).toBe(200)
    const game = res.json()
    expect(game).toMatchObject({ id, status: 'active', turn: sam.id, opponent_id: sam.id })
    expect(game.view.board[4]).toBe('X')
    expect(game.view.marks).toEqual({ X: dad.id, O: sam.id })
  })

  it('GET /api/games/{id}/events returns the ordered move stream for replay [GAME-008]', async () => {
    const id = await activeTtt()
    await move(dad.id, id, { cell: 0 })
    await move(sam.id, id, { cell: 4 })
    await move(dad.id, id, { cell: 8 })

    const { events, next_after } = await gameEvents(id, alex.id)
    expect(events.map((e) => e.type)).toEqual([
      'game.created',
      'game.joined',
      'game.move',
      'game.move',
      'game.move',
    ])
    const moves = events.filter((e) => e.type === 'game.move')
    expect(moves.map((e) => e.payload.move_no)).toEqual([1, 2, 3])
    expect(moves.map((e) => e.payload.move.cell)).toEqual([0, 4, 8])
    const seqs = events.map((e) => e.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    expect(next_after).toBe(seqs[seqs.length - 1])
    // Cursor pagination: nothing after the last event.
    const tail = await t.app.inject({
      method: 'GET',
      url: `/api/games/${id}/events?after=${next_after}`,
      headers: asProfile(alex.id),
    })
    expect(tail.json().events).toEqual([])
  })

  it('spectators long-polling the game stream observe moves as they happen [GAME-009]', async () => {
    const id = await activeTtt()
    const { next_after } = await gameEvents(id, alex.id)

    const waiting = t.app.inject({
      method: 'GET',
      url: `/api/games/${id}/events?after=${next_after}&wait=10`,
      headers: asProfile(alex.id),
    })
    const started = Date.now()
    setTimeout(() => void move(dad.id, id, { cell: 6 }), 250)
    const res = await waiting
    expect(Date.now() - started).toBeLessThan(8000)
    const events = res.json().events
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('game.move')
    expect(events[0].payload.move).toEqual({ cell: 6 })
  })

  it('the game stream only carries the requested game [GAME-009]', async () => {
    const a = await activeTtt()
    const b = await activeTtt()
    await move(dad.id, a, { cell: 0 })
    await move(dad.id, b, { cell: 8 })
    const { events } = await gameEvents(a, alex.id)
    expect(events.every((e) => e.payload.game_id === a)).toBe(true)
  })
})

describe('hangman over the API', () => {
  it('validates hangman words at creation [GAME-013]', async () => {
    const gibberish = await createGame(dad.id, { game_type: 'hangman', mode: 'open', options: { word: 'qqqzz' } })
    expect(gibberish.statusCode).toBe(400)
    expect(gibberish.json().error.code).toBe('validation')
    expect(gibberish.json().error.message).toMatch(/dictionary/i)

    const real = await createGame(dad.id, { game_type: 'hangman', mode: 'open', options: { word: 'banana' } })
    expect(real.statusCode).toBe(201)

    const ignored = await createGame(dad.id, {
      game_type: 'hangman',
      mode: 'open',
      options: { word: 'qqqzz', ignore_dictionary: true },
    })
    expect(ignored.statusCode).toBe(201)

    const tooMany = await createGame(dad.id, {
      game_type: 'hangman',
      mode: 'open',
      options: { word: 'one two three four' },
    })
    expect(tooMany.statusCode).toBe(400)

    const tooLong = await createGame(dad.id, {
      game_type: 'hangman',
      mode: 'open',
      options: { word: 'abcdefghijklmnop', ignore_dictionary: true },
    })
    expect(tooLong.statusCode).toBe(400)

    const noWord = await createGame(dad.id, { game_type: 'hangman', mode: 'open' })
    expect(noWord.statusCode).toBe(400)
  })

  it('hides the word from guesser and spectators but shows spaces [GAME-014]', async () => {
    const created = await createGame(dad.id, { game_type: 'hangman', mode: 'open', options: { word: 'road trip' } })
    const id = created.json().id
    await join(sam.id, id)
    await move(sam.id, id, { letter: 'r' })

    const guesser = (await t.app.inject({ method: 'GET', url: `/api/games/${id}`, headers: asProfile(sam.id) })).json()
    expect(guesser.view.display).toBe('r___ _r__')
    expect(JSON.stringify(guesser)).not.toMatch(/road|trip/)
    expect(guesser.turn).toBe(sam.id)

    const spectator = (await t.app.inject({ method: 'GET', url: `/api/games/${id}`, headers: asProfile(alex.id) })).json()
    expect(JSON.stringify(spectator)).not.toMatch(/road|trip/)

    const setter = (await t.app.inject({ method: 'GET', url: `/api/games/${id}`, headers: asProfile(dad.id) })).json()
    expect(setter.view.word).toBe('road trip')
  })

  it('six wrong guesses finish the game for the setter [GAME-007]', async () => {
    const created = await createGame(dad.id, { game_type: 'hangman', mode: 'open', options: { word: 'banana' } })
    const id = created.json().id
    await join(sam.id, id)
    for (const letter of 'qwxzjk') {
      expect((await move(sam.id, id, { letter })).statusCode).toBe(200)
    }
    const game = (await t.app.inject({ method: 'GET', url: `/api/games/${id}`, headers: asProfile(sam.id) })).json()
    expect(game).toMatchObject({ status: 'finished', result: 'win', winner_id: dad.id })
    expect(game.view.word).toBe('banana') // revealed once over
  })
})

describe('resign and notifications', () => {
  it('resigning finishes the game as a win for the opponent [GAME-015]', async () => {
    const id = await activeTtt()
    await move(dad.id, id, { cell: 4 })

    const outsider = await t.app.inject({
      method: 'POST',
      url: `/api/games/${id}/resign`,
      headers: asProfile(alex.id),
    })
    expect(outsider.statusCode).toBe(403)

    const res = await t.app.inject({ method: 'POST', url: `/api/games/${id}/resign`, headers: asProfile(sam.id) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'finished', result: 'win', winner_id: dad.id })

    const { events } = await gameEvents(id, alex.id)
    const finished = events.find((e) => e.type === 'game.finished')
    expect(finished.payload).toMatchObject({
      result: 'win',
      winner_profile_id: dad.id,
      loser_profile_id: sam.id,
      resigned: true,
    })

    const again = await t.app.inject({ method: 'POST', url: `/api/games/${id}/resign`, headers: asProfile(dad.id) })
    expect(again.statusCode).toBe(409)
  })

  it('challenges record the invited profile in game.created for notification derivation [GAME-016]', async () => {
    const created = await createGame(dad.id, {
      game_type: 'chess',
      mode: 'challenge',
      invited_profile_id: sam.id,
    })
    expect(created.statusCode).toBe(201)
    const id = created.json().id
    const events = await t.app.inject({
      method: 'GET',
      url: '/api/events?types=game.created',
      headers: asProfile(sam.id),
    })
    const ev = events.json().events.find((e: any) => e.payload.game_id === id)
    // NOTIF-002 derives the challenge notification from exactly this field.
    expect(ev.payload.invited_profile_id).toBe(sam.id)
    expect(ev.payload.mode).toBe('challenge')
  })
})
