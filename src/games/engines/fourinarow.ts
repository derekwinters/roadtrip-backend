import { z } from 'zod'
import type { BaseState, GameEngine, ProfileId } from '../types.js'

/**
 * Four in a Row (GAME-020): 7 columns × 6 rows, the creator (players[0]) moves first.
 * A move names a column only; the disc lands in the lowest empty row of that column.
 */

export const COLUMNS = 7
export const ROWS = 6
const LINE = 4

type Board = (0 | 1 | null)[][]

export interface FourInARowMove {
  column: number
}

export interface FourInARowState extends BaseState {
  /**
   * `[row][column]`, 6 × 7, row 0 = bottom. 0 = a players[0] disc, 1 = a players[1] disc,
   * null = empty. A disc's row equals the number of discs already in its column.
   */
  board: Board
}

// Non-strict: a recorded move's advisory `row` is stripped on re-apply, so the landing
// row is always re-derived by gravity and the fold stays deterministic (GAME-006).
const moveSchema = z.object({ column: z.number().int().min(0).max(COLUMNS - 1) })

/** The disc at `[row][column]`; off-board positions read as `undefined`. */
function at(board: Board, row: number, column: number): 0 | 1 | null | undefined {
  return board[row]?.[column]
}

/** The lowest empty row of a column, or null when the column is full. */
function landingRow(board: Board, column: number): number | null {
  for (let row = 0; row < ROWS; row++) if (at(board, row, column) === null) return row
  return null
}

/** Directions to scan from each disc: right, up, up-right, down-right. */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [-1, 1],
]

function winnerIndex(board: Board): 0 | 1 | null {
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      const v = at(board, row, col)
      if (v === null || v === undefined) continue
      for (const [dr, dc] of DIRECTIONS) {
        let n = 1
        while (n < LINE) {
          if (at(board, row + dr * n, col + dc * n) !== v) break
          n++
        }
        if (n === LINE) return v
      }
    }
  }
  return null
}

export const fourinarow: GameEngine<FourInARowState, FourInARowMove> = {
  init(_options, players) {
    const board = Array.from({ length: ROWS }, () => Array<0 | 1 | null>(COLUMNS).fill(null))
    return { players, turn: players[0], board }
  },

  validate(state, by, move) {
    if (fourinarow.status(state).phase !== 'ongoing') return { ok: false, reason: 'the game is already over' }
    if (!state.players.includes(by)) return { ok: false, reason: 'not a player in this game' }
    if (by !== state.turn) return { ok: false, reason: 'not your turn' }
    const parsed = moveSchema.safeParse(move)
    if (!parsed.success) return { ok: false, reason: `move must be { column: 0..${COLUMNS - 1} }` }
    if (landingRow(state.board, parsed.data.column) === null) {
      return { ok: false, reason: `column ${parsed.data.column} is full` }
    }
    return { ok: true }
  },

  apply(state, by, move) {
    const { column } = moveSchema.parse(move)
    const row = landingRow(state.board, column)
    if (row === null) throw new Error(`column ${column} is full`)
    const idx = state.players.indexOf(by) as 0 | 1
    const board = state.board.map((r, i) => (i === row ? r.map((c, j) => (j === column ? idx : c)) : r.slice()))
    return { players: state.players, turn: state.players[(1 - idx) as 0 | 1], board }
  },

  status(state) {
    const w = winnerIndex(state.board)
    if (w !== null) return { phase: 'won', winner: state.players[w] }
    if (state.board.every((r) => r.every((c) => c !== null))) return { phase: 'draw' }
    return { phase: 'ongoing' }
  },

  /** Viewerless: nothing is hidden. `discs[v]` is the profile owning cell value `v`. */
  view(state, _viewer?: ProfileId) {
    return {
      board: state.board.map((r) => r.slice()),
      discs: [state.players[0], state.players[1]],
      turn: state.turn,
      players: state.players,
    }
  },

  /**
   * Normalizes the recorded `game.move` to `{ column, row }` (GAME-020) so replay clients
   * need not recount the column. `row` is advisory: re-applying ignores it (see moveSchema).
   */
  record(state, _by, move) {
    const { column } = moveSchema.parse(move)
    return { column, row: landingRow(state.board, column) }
  },
}
