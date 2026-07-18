import { z } from 'zod'
import type { BaseState, GameEngine, ProfileId } from '../types.js'

/** Tic-tac-toe (GAME-017): 3×3 board, X = creator = players[0]. */

export interface TttMove {
  cell: number
}

export interface TttState extends BaseState {
  /** 9 cells; 0 = players[0] (X), 1 = players[1] (O), null = empty. */
  cells: (0 | 1 | null)[]
}

const moveSchema = z.object({ cell: z.number().int().min(0).max(8) })

export const LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
]

function winnerIndex(cells: (0 | 1 | null)[]): 0 | 1 | null {
  for (const [a, b, c] of LINES) {
    const v = cells[a]
    if (v !== null && v !== undefined && cells[b] === v && cells[c] === v) return v
  }
  return null
}

export const tictactoe: GameEngine<TttState, TttMove> = {
  init(_options, players) {
    return { players, turn: players[0], cells: Array<0 | 1 | null>(9).fill(null) }
  },

  validate(state, by, move) {
    if (tictactoe.status(state).phase !== 'ongoing') return { ok: false, reason: 'the game is already over' }
    if (!state.players.includes(by)) return { ok: false, reason: 'not a player in this game' }
    if (by !== state.turn) return { ok: false, reason: 'not your turn' }
    const parsed = moveSchema.safeParse(move)
    if (!parsed.success) return { ok: false, reason: 'move must be { cell: 0..8 }' }
    if (state.cells[parsed.data.cell] !== null) {
      return { ok: false, reason: `cell ${parsed.data.cell} is already taken` }
    }
    return { ok: true }
  },

  apply(state, by, move) {
    const { cell } = moveSchema.parse(move)
    const idx = state.players.indexOf(by) as 0 | 1
    const cells = state.cells.slice()
    cells[cell] = idx
    return { players: state.players, turn: state.players[(1 - idx) as 0 | 1], cells }
  },

  status(state) {
    const w = winnerIndex(state.cells)
    if (w !== null) return { phase: 'won', winner: state.players[w] }
    if (state.cells.every((c) => c !== null)) return { phase: 'draw' }
    return { phase: 'ongoing' }
  },

  view(state, _viewer?: ProfileId) {
    return {
      board: state.cells.map((c) => (c === null ? null : c === 0 ? 'X' : 'O')),
      marks: { X: state.players[0], O: state.players[1] },
      turn: state.turn,
      players: state.players,
    }
  },
}
