import { z } from 'zod'
import type { BaseState, GameEngine } from '../types.js'

/**
 * Ultimate tic-tac-toe (GAME-012): nine 3×3 sub-boards. The cell index of each move
 * dictates the sub-board the opponent must play next; if that sub-board is already
 * decided (won or full), the opponent chooses freely. Three sub-board wins in a row
 * take the macro board; a full sub-board without a winner counts for neither side
 * ('D' on the macro board).
 */

export interface UltimateMove {
  board: number
  cell: number
}

export interface UltimateState extends BaseState {
  /** boards[b][c]: 0 = players[0] (X), 1 = players[1] (O), null = empty. */
  boards: (0 | 1 | null)[][]
  /** Per sub-board: winner index, 'D' for drawn/full, null while undecided. */
  macro: (0 | 1 | 'D' | null)[]
  /** Sub-board the player to move MUST use, or null for free choice. */
  nextBoard: number | null
}

const idx = z.number().int().min(0).max(8)
const moveSchema = z.object({ board: idx, cell: idx })

const LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
]

function lineWinner(cells: ReadonlyArray<0 | 1 | 'D' | null>): 0 | 1 | null {
  for (const [a, b, c] of LINES) {
    const v = cells[a]
    if ((v === 0 || v === 1) && cells[b] === v && cells[c] === v) return v
  }
  return null
}

export const ultimate: GameEngine<UltimateState, UltimateMove> = {
  init(_options, players) {
    return {
      players,
      turn: players[0],
      boards: Array.from({ length: 9 }, () => Array<0 | 1 | null>(9).fill(null)),
      macro: Array<0 | 1 | 'D' | null>(9).fill(null),
      nextBoard: null,
    }
  },

  validate(state, by, move) {
    if (ultimate.status(state).phase !== 'ongoing') return { ok: false, reason: 'the game is already over' }
    if (!state.players.includes(by)) return { ok: false, reason: 'not a player in this game' }
    if (by !== state.turn) return { ok: false, reason: 'not your turn' }
    const parsed = moveSchema.safeParse(move)
    if (!parsed.success) return { ok: false, reason: 'move must be { board: 0..8, cell: 0..8 }' }
    const { board, cell } = parsed.data
    if (state.nextBoard !== null && board !== state.nextBoard) {
      return { ok: false, reason: `you must play in sub-board ${state.nextBoard}` }
    }
    if (state.macro[board] !== null) return { ok: false, reason: `sub-board ${board} is already decided` }
    if (state.boards[board]![cell] !== null) return { ok: false, reason: `cell ${cell} of sub-board ${board} is taken` }
    return { ok: true }
  },

  apply(state, by, move) {
    const { board, cell } = moveSchema.parse(move)
    const me = state.players.indexOf(by) as 0 | 1
    const boards = state.boards.map((b) => b.slice())
    boards[board]![cell] = me
    const macro = state.macro.slice()
    const sub = boards[board]!
    const w = lineWinner(sub)
    if (w !== null) macro[board] = w
    else if (sub.every((c) => c !== null)) macro[board] = 'D'
    return {
      players: state.players,
      turn: state.players[(1 - me) as 0 | 1],
      boards,
      macro,
      // Free choice when the dictated sub-board is already won/drawn/full (GAME-012).
      nextBoard: macro[cell] === null ? cell : null,
    }
  },

  status(state) {
    const w = lineWinner(state.macro)
    if (w !== null) return { phase: 'won', winner: state.players[w] }
    if (state.macro.every((m) => m !== null)) return { phase: 'draw' }
    return { phase: 'ongoing' }
  },

  view(state) {
    return {
      boards: state.boards,
      macro: state.macro,
      next_board: state.nextBoard,
      turn: state.turn,
      players: state.players,
    }
  },
}
