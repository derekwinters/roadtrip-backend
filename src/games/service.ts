import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { appendEvent } from '../events/store.js'
import { validateEventPayload } from '../events/schemas.js'
import { AppError, conflict, forbidden, notFound, validation } from '../errors.js'
import { getEngine, type GameType } from './registry.js'
import { validateHangmanOptions } from './engines/hangman.js'
import type { BaseState } from './types.js'

/**
 * Game platform service (GAME-001..017). Every mutation is one transaction that
 * updates the `games` read model and appends the corresponding game.* event —
 * the event stream stays the system of record: `games.state` is only the cached
 * fold of the stream (GAME-006) and is rebuildable from it.
 */

export const GAME_EVENT_TYPES = ['game.created', 'game.joined', 'game.move', 'game.finished', 'game.abandoned']

export interface GameRow {
  id: string
  game_type: GameType
  mode: 'open' | 'challenge'
  status: 'open' | 'active' | 'finished' | 'abandoned'
  created_by: string
  invited_profile_id: string | null
  opponent_id: string | null
  options: Record<string, unknown>
  state: (BaseState & Record<string, unknown>) | null
  move_count: number
  result: 'win' | 'draw' | 'abandoned' | null
  winner_id: string | null
  created_at: string | Date
  finished_at: string | Date | null
}

export interface CreateGameInput {
  game_type: GameType
  mode: 'open' | 'challenge'
  invited_profile_id?: string
  options?: Record<string, unknown>
}

const iso = (v: string | Date | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : v

/**
 * Serializes a game row for the API (openapi `Game` schema). `options` is
 * deliberately NOT part of the wire shape — for hangman it contains the word, which
 * must never reach guesser/spectator clients (GAME-014); state is exposed only
 * through the engine's viewer-aware `view` (GAME-008).
 */
export function toWire(row: GameRow, viewer?: string, includeView = true): Record<string, unknown> {
  return {
    id: row.id,
    game_type: row.game_type,
    mode: row.mode,
    status: row.status,
    created_by: row.created_by,
    invited_profile_id: row.invited_profile_id,
    opponent_id: row.opponent_id,
    move_count: row.move_count,
    result: row.result,
    winner_id: row.winner_id,
    turn: row.status === 'active' && row.state ? row.state.turn : null,
    view: includeView && row.state ? getEngine(row.game_type).view(row.state, viewer) : null,
    created_at: iso(row.created_at),
    finished_at: iso(row.finished_at),
  }
}

/** Appends a server-derived game event, enforcing the zod payload catalog (EVT-003). */
async function emit(db: pg.PoolClient, type: string, actorId: string | null, payload: unknown): Promise<void> {
  const checked = validateEventPayload(type, payload)
  if (!checked.ok) throw new Error(`internal: invalid ${type} payload: ${checked.error}`)
  await appendEvent(db, { type, actorId, payload: checked.payload, clientTs: new Date() })
}

async function inTransaction<T>(app: FastifyInstance, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function lockGame(client: pg.PoolClient, id: string): Promise<GameRow> {
  const { rows } = await client.query('SELECT * FROM games WHERE id = $1 FOR UPDATE', [id])
  if (rows.length === 0) throw notFound('Game')
  return rows[0] as GameRow
}

export async function createGame(app: FastifyInstance, creatorId: string, input: CreateGameInput): Promise<Record<string, unknown>> {
  if (input.mode === 'challenge' && !input.invited_profile_id) {
    throw validation('mode=challenge requires invited_profile_id')
  }
  if (input.mode === 'open' && input.invited_profile_id) {
    throw validation('invited_profile_id is only valid for mode=challenge')
  }
  if (input.invited_profile_id === creatorId) {
    throw validation('you cannot challenge yourself')
  }
  if (input.invited_profile_id) {
    const { rows } = await app.pool.query('SELECT 1 FROM profiles WHERE id = $1', [input.invited_profile_id])
    if (rows.length === 0) throw validation('invited profile does not exist')
  }
  if (input.game_type === 'hangman') {
    const checked = validateHangmanOptions(input.options ?? {})
    if (!checked.ok) throw validation(checked.reason) // GAME-013: word rules at create time
  }

  const options = input.options ?? {}
  const id = randomUUID()
  const row = await inTransaction(app, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO games (id, game_type, mode, created_by, invited_profile_id, options)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, input.game_type, input.mode, creatorId, input.invited_profile_id ?? null, JSON.stringify(options)],
    )
    await emit(client, 'game.created', creatorId, {
      game_id: id,
      game_type: input.game_type,
      mode: input.mode,
      // GAME-016: NOTIF-002 derives the challenge notification from this field.
      ...(input.invited_profile_id ? { invited_profile_id: input.invited_profile_id } : {}),
      options,
    })
    return rows[0] as GameRow
  })
  app.bus.notify()
  return toWire(row, creatorId)
}

export async function joinGame(app: FastifyInstance, joinerId: string, id: string): Promise<Record<string, unknown>> {
  const row = await inTransaction(app, async (client) => {
    const game = await lockGame(client, id)
    if (game.created_by === joinerId) throw conflict('conflict', 'You cannot join your own game')
    if (game.status !== 'open') throw conflict('game_full', 'This game already has two players') // GAME-003
    if (game.mode === 'challenge' && game.invited_profile_id !== joinerId) {
      throw forbidden('not_invited', 'Only the invited profile can join this challenge') // GAME-002
    }
    // Both players are fixed now: fold starts here — creator is players[0] (GAME-006).
    const engine = getEngine(game.game_type)
    const state = engine.init(game.options, [game.created_by, joinerId])
    const { rows } = await client.query(
      `UPDATE games SET status = 'active', opponent_id = $2, state = $3 WHERE id = $1 RETURNING *`,
      [id, joinerId, JSON.stringify(state)],
    )
    await emit(client, 'game.joined', joinerId, { game_id: id, profile_id: joinerId })
    return rows[0] as GameRow
  })
  app.bus.notify()
  return toWire(row, joinerId)
}

export async function makeMove(app: FastifyInstance, byId: string, id: string, move: unknown): Promise<Record<string, unknown>> {
  const row = await inTransaction(app, async (client) => {
    const game = await lockGame(client, id)
    if (game.created_by !== byId && game.opponent_id !== byId) {
      throw forbidden('not_your_turn', 'You are not a player in this game') // GAME-005
    }
    if (game.status !== 'active' || !game.state) throw conflict('conflict', 'Game is not active') // GAME-005
    const engine = getEngine(game.game_type)
    if (game.state.turn !== byId) throw conflict('not_your_turn', 'It is not your turn') // GAME-005

    const verdict = engine.validate(game.state, byId, move)
    if (!verdict.ok) throw new AppError(400, 'illegal_move', verdict.reason) // GAME-004

    const state = engine.apply(game.state, byId, move)
    const moveNo = game.move_count + 1
    // Engines may normalize the recorded move (e.g. checkers adds captured squares for
    // replay clients, GAME-011); re-applying it must be state-equivalent (GAME-006).
    const recorded = engine.record ? engine.record(game.state, byId, move) : move
    await emit(client, 'game.move', byId, { game_id: id, move_no: moveNo, move: recorded })

    const status = engine.status(state)
    if (status.phase === 'ongoing') {
      const { rows } = await client.query(
        'UPDATE games SET state = $2, move_count = $3 WHERE id = $1 RETURNING *',
        [id, JSON.stringify(state), moveNo],
      )
      return rows[0] as GameRow
    }

    // GAME-007: win/draw detection ends the game and emits game.finished.
    const winnerId = status.phase === 'won' ? status.winner : null
    const loserId = winnerId === null ? null : winnerId === game.created_by ? game.opponent_id : game.created_by
    const { rows } = await client.query(
      `UPDATE games SET state = $2, move_count = $3, status = 'finished', result = $4,
              winner_id = $5, finished_at = now()
       WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(state), moveNo, status.phase === 'won' ? 'win' : 'draw', winnerId],
    )
    await emit(client, 'game.finished', null, {
      game_id: id,
      game_type: game.game_type,
      result: status.phase === 'won' ? 'win' : 'draw',
      ...(winnerId ? { winner_profile_id: winnerId, loser_profile_id: loserId } : {}),
      move_count: moveNo,
    })
    return rows[0] as GameRow
  })
  app.bus.notify()
  return toWire(row, byId)
}

export async function resignGame(app: FastifyInstance, byId: string, id: string): Promise<Record<string, unknown>> {
  const row = await inTransaction(app, async (client) => {
    const game = await lockGame(client, id)
    if (game.created_by !== byId && game.opponent_id !== byId) {
      throw forbidden('not_your_turn', 'You are not a player in this game')
    }
    if (game.status !== 'active') throw conflict('conflict', 'Game is not active')
    // GAME-015: resigning is a win for the opponent.
    const winnerId = byId === game.created_by ? game.opponent_id! : game.created_by
    const { rows } = await client.query(
      `UPDATE games SET status = 'finished', result = 'win', winner_id = $2, finished_at = now()
       WHERE id = $1 RETURNING *`,
      [id, winnerId],
    )
    await emit(client, 'game.finished', byId, {
      game_id: id,
      game_type: game.game_type,
      result: 'win',
      winner_profile_id: winnerId,
      loser_profile_id: byId,
      move_count: game.move_count,
      resigned: true,
    })
    return rows[0] as GameRow
  })
  app.bus.notify()
  return toWire(row, byId)
}

export async function getGame(app: FastifyInstance, viewerId: string, id: string): Promise<Record<string, unknown>> {
  const { rows } = await app.pool.query('SELECT * FROM games WHERE id = $1', [id])
  if (rows.length === 0) throw notFound('Game')
  return toWire(rows[0] as GameRow, viewerId) // GAME-008: viewer-aware engine view
}

export async function listGames(
  app: FastifyInstance,
  filters: { status?: string; profile?: string },
): Promise<Array<Record<string, unknown>>> {
  const clauses: string[] = []
  const args: unknown[] = []
  if (filters.status) {
    args.push(filters.status)
    clauses.push(`status = $${args.length}`)
  }
  if (filters.profile) {
    args.push(filters.profile)
    clauses.push(`(created_by = $${args.length} OR opponent_id = $${args.length} OR invited_profile_id = $${args.length})`)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const { rows } = await app.pool.query(`SELECT * FROM games ${where} ORDER BY created_at DESC, id`, args)
  // List views are viewerless summaries; the per-viewer engine view is on GET /api/games/{id}.
  return rows.map((r) => toWire(r as GameRow, undefined, false))
}

/**
 * Redacts hangman words from game.created payloads in event feeds while the game is
 * unfinished (GAME-014): the raw event stream is family-visible, so the word may only
 * appear once the game has ended (replays of finished games are unaffected).
 */
export async function redactOngoingHangmanWords<T extends { type: string; payload: any }>(
  db: pg.Pool,
  events: T[],
): Promise<T[]> {
  const candidates = events.filter(
    (e) => e.type === 'game.created' && e.payload?.options && typeof e.payload.options.word === 'string',
  )
  if (candidates.length === 0) return events
  const ids = [...new Set(candidates.map((e) => e.payload.game_id))]
  const { rows } = await db.query(`SELECT id FROM games WHERE id = ANY($1) AND status = 'finished'`, [ids])
  const finished = new Set(rows.map((r) => r.id))
  return events.map((e) => {
    if (e.type !== 'game.created') return e
    const opts = e.payload?.options
    if (!opts || typeof opts.word !== 'string' || finished.has(e.payload.game_id)) return e
    return { ...e, payload: { ...e.payload, options: { ...opts, word: '•••' } } }
  })
}
