import { Chess } from 'chess.js'
import { z } from 'zod'
import type { BaseState, GameEngine } from '../types.js'

/**
 * Chess (GAME-010): ALL legality, check(mate), stalemate and draw rules come from
 * chess.js — this engine never re-implements chess rules and never accepts a move
 * chess.js rejects. The creator plays white (players[0]).
 *
 * The folded state stores the full move list; every operation replays it from the
 * initial position so history-dependent rules (threefold repetition, 50-move rule)
 * are exact. Games are short enough that the O(n²) replay cost is irrelevant.
 */

export interface ChessMove {
  from: string
  to: string
  promotion?: string
}

export interface ChessState extends BaseState {
  moves: ChessMove[]
  /** Cached FEN of the position after `moves` — for views; `moves` is the truth. */
  fen: string
}

const square = z.string().regex(/^[a-h][1-8]$/)
const moveSchema = z.object({
  from: square,
  to: square,
  promotion: z.enum(['q', 'r', 'b', 'n']).optional(),
})

function replay(moves: ChessMove[]): Chess {
  const game = new Chess()
  for (const m of moves) game.move({ from: m.from, to: m.to, promotion: m.promotion })
  return game
}

export const chess: GameEngine<ChessState, ChessMove> = {
  init(_options, players) {
    return { players, turn: players[0], moves: [], fen: new Chess().fen() }
  },

  validate(state, by, move) {
    if (chess.status(state).phase !== 'ongoing') return { ok: false, reason: 'the game is already over' }
    if (!state.players.includes(by)) return { ok: false, reason: 'not a player in this game' }
    if (by !== state.turn) return { ok: false, reason: 'not your turn' }
    const parsed = moveSchema.safeParse(move)
    if (!parsed.success) {
      return { ok: false, reason: 'move must be { from: "e2", to: "e4", promotion?: "q"|"r"|"b"|"n" }' }
    }
    const game = replay(state.moves)
    try {
      game.move({ from: parsed.data.from, to: parsed.data.to, promotion: parsed.data.promotion })
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'illegal move' }
    }
  },

  apply(state, _by, move) {
    const parsed = moveSchema.parse(move)
    const game = replay(state.moves)
    game.move({ from: parsed.from, to: parsed.to, promotion: parsed.promotion })
    // Store exactly the normalized client move so the fold over game.move events is
    // deterministic (GAME-006); the promotion key is present only when supplied.
    const stored: ChessMove =
      parsed.promotion !== undefined
        ? { from: parsed.from, to: parsed.to, promotion: parsed.promotion }
        : { from: parsed.from, to: parsed.to }
    return {
      players: state.players,
      turn: game.turn() === 'w' ? state.players[0] : state.players[1],
      moves: [...state.moves, stored],
      fen: game.fen(),
    }
  },

  status(state) {
    const game = replay(state.moves)
    if (game.isCheckmate()) {
      // The side to move is mated; the other player wins.
      return { phase: 'won', winner: game.turn() === 'w' ? state.players[1] : state.players[0] }
    }
    if (game.isStalemate() || game.isDraw()) return { phase: 'draw' }
    return { phase: 'ongoing' }
  },

  view(state) {
    const game = replay(state.moves)
    return {
      fen: state.fen,
      turn: state.turn,
      players: { white: state.players[0], black: state.players[1] },
      in_check: game.isCheck(),
      move_count: state.moves.length,
      last_move: state.moves.length > 0 ? state.moves[state.moves.length - 1] : null,
    }
  },
}
