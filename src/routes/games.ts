import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireProfile } from '../auth.js'
import { validation, notFound } from '../errors.js'
import { listEvents } from '../events/store.js'
import { GAME_TYPES } from '../games/registry.js'
import {
  GAME_EVENT_TYPES,
  createGame,
  getGame,
  joinGame,
  listGames,
  makeMove,
  redactOngoingHangmanWords,
  resignGame,
} from '../games/service.js'

/** GAME-001..017 game platform routes. OWNER: games feature. */

const idParams = z.object({ id: z.string().uuid() })

const createSchema = z
  .object({
    game_type: z.enum(GAME_TYPES),
    mode: z.enum(['open', 'challenge']),
    invited_profile_id: z.string().uuid().optional(),
    options: z.record(z.unknown()).optional(),
  })
  .strict()

const listQuerySchema = z.object({
  status: z.enum(['open', 'active', 'finished', 'abandoned']).optional(),
  profile: z.string().uuid().optional(),
})

const streamQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  wait: z.coerce.number().int().min(1).max(30).optional(),
})

export async function gameRoutes(app: FastifyInstance): Promise<void> {
  // GAME-001: lobby and game lists (status/profile filters).
  app.get('/api/games', { preHandler: [requireProfile] }, async (req) => {
    const q = listQuerySchema.parse(req.query)
    return listGames(app, q)
  })

  // GAME-001/002 create (GAME-013: hangman word rules at create time).
  app.post('/api/games', { preHandler: [requireProfile] }, async (req, reply) => {
    const body = createSchema.parse(req.body ?? {})
    const game = await createGame(app, req.profile!.id, body)
    return reply.status(201).send(game)
  })

  // GAME-008: current state through the engine's viewer-aware view.
  app.get('/api/games/:id', { preHandler: [requireProfile] }, async (req) => {
    const { id } = idParams.parse(req.params)
    return getGame(app, req.profile!.id, id)
  })

  // GAME-002/003: join with invite rules.
  app.post('/api/games/:id/join', { preHandler: [requireProfile] }, async (req) => {
    const { id } = idParams.parse(req.params)
    return joinGame(app, req.profile!.id, id)
  })

  // GAME-004/005: engine-validated, turn-ordered moves.
  app.post('/api/games/:id/moves', { preHandler: [requireProfile] }, async (req) => {
    const { id } = idParams.parse(req.params)
    const body = req.body
    if (typeof body !== 'object' || body === null || !('move' in body)) {
      throw validation('body must be { move: <game-specific move> }')
    }
    return makeMove(app, req.profile!.id, id, (body as { move: unknown }).move)
  })

  // GAME-015: resign — a win for the opponent.
  app.post('/api/games/:id/resign', { preHandler: [requireProfile] }, async (req) => {
    const { id } = idParams.parse(req.params)
    return resignGame(app, req.profile!.id, id)
  })

  // GAME-008/009: ordered game.* stream for replay and spectating, long-pollable.
  // game.created payloads have hangman words redacted until the game finishes (GAME-014);
  // finished-game replays see the real word.
  app.get('/api/games/:id/events', { preHandler: [requireProfile] }, async (req) => {
    const { id } = idParams.parse(req.params)
    const q = streamQuerySchema.parse(req.query)
    const { rows } = await app.pool.query('SELECT 1 FROM games WHERE id = $1', [id])
    if (rows.length === 0) throw notFound('Game')

    const params = {
      after: q.after,
      limit: 500,
      types: GAME_EVENT_TYPES,
      payloadFilter: { path: 'game_id', value: id },
    }
    const deadline = Date.now() + (q.wait ?? 0) * 1000
    let events = await listEvents(app.pool, params)
    while (events.length === 0 && Date.now() < deadline) {
      await app.bus.waitForEvent(Math.min(deadline - Date.now(), 5000))
      events = await listEvents(app.pool, params)
    }
    const nextAfter = events.length > 0 ? events[events.length - 1]!.seq : q.after
    return { events: await redactOngoingHangmanWords(app.pool, events), next_after: nextAfter }
  })
}
