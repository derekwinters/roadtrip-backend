import { z } from 'zod'
import type { BaseState, GameEngine, ProfileId } from '../types.js'

/**
 * Dots and Boxes (GAME-023): a fixed grid of 7 columns × 6 rows of boxes (8 × 7 dots),
 * the creator (players[0]) moves first. A move draws one edge; completing a box claims it
 * and the mover moves again, so turns do not strictly alternate.
 *
 * Coordinates (docs/spec/08-games.md): dots are (dotRow 0..6 from the top, dotCol 0..7).
 * `h(row, col)` joins dot (row, col) → (row, col + 1); `v(row, col)` joins (row, col) →
 * (row + 1, col). Box (row, col) is bounded by h(row, col), h(row + 1, col), v(row, col)
 * and v(row, col + 1).
 */

export const BOX_COLUMNS = 7
export const BOX_ROWS = 6
/** 7 × 7 horizontal + 6 × 8 vertical. */
export const EDGE_COUNT = (BOX_ROWS + 1) * BOX_COLUMNS + BOX_ROWS * (BOX_COLUMNS + 1)

export type Orientation = 'h' | 'v'

export interface DotsAndBoxesMove {
  row: number
  col: number
  orientation: Orientation
}

export interface DrawnEdge extends DotsAndBoxesMove {
  /** Index into `players` of whoever drew the edge. */
  by: 0 | 1
}

export interface DotsAndBoxesState extends BaseState {
  /**
   * Every drawn edge in draw order. This is the only board state: which boxes are claimed,
   * and by whom, is re-derived from it on every read (GAME-023 invariant), never stored.
   */
  drawn: DrawnEdge[]
}

type Grid = (0 | 1 | null)[][]

/** Rows × columns of the edge grid for an orientation. */
function edgeDims(orientation: Orientation): [rows: number, cols: number] {
  return orientation === 'h' ? [BOX_ROWS + 1, BOX_COLUMNS] : [BOX_ROWS, BOX_COLUMNS + 1]
}

// Non-strict: unknown extra keys are stripped. Range is checked per orientation below.
const moveSchema = z.object({
  row: z.number().int().min(0),
  col: z.number().int().min(0),
  orientation: z.enum(['h', 'v']),
})

function parseEdge(move: unknown): DotsAndBoxesMove | null {
  const parsed = moveSchema.safeParse(move)
  if (!parsed.success) return null
  const [rows, cols] = edgeDims(parsed.data.orientation)
  if (parsed.data.row >= rows || parsed.data.col >= cols) return null
  return parsed.data
}

const emptyGrid = (rows: number, cols: number): Grid =>
  Array.from({ length: rows }, () => Array<0 | 1 | null>(cols).fill(null))

/** The boxes an edge borders: above/below for `h`, left/right for `v` (off-board ones dropped). */
function adjacentBoxes({ row, col, orientation }: DotsAndBoxesMove): Array<[number, number]> {
  const sides: Array<[number, number]> =
    orientation === 'h'
      ? [
          [row - 1, col],
          [row, col],
        ]
      : [
          [row, col - 1],
          [row, col],
        ]
  return sides.filter(([r, c]) => r >= 0 && r < BOX_ROWS && c >= 0 && c < BOX_COLUMNS)
}

function boxComplete(h: Grid, v: Grid, r: number, c: number): boolean {
  return h[r]![c] !== null && h[r + 1]![c] !== null && v[r]![c] !== null && v[r]![c + 1] !== null
}

interface Board {
  h: Grid
  v: Grid
  boxes: Grid
}

/**
 * Folds the drawn edges in order: a box belongs to whoever drew the edge that completed it.
 * Returns the edge grids (who drew each edge) and the box owners.
 */
function derive(drawn: readonly DrawnEdge[]): Board {
  const h = emptyGrid(BOX_ROWS + 1, BOX_COLUMNS)
  const v = emptyGrid(BOX_ROWS, BOX_COLUMNS + 1)
  const boxes = emptyGrid(BOX_ROWS, BOX_COLUMNS)
  for (const edge of drawn) {
    ;(edge.orientation === 'h' ? h : v)[edge.row]![edge.col] = edge.by
    for (const [r, c] of adjacentBoxes(edge)) {
      if (boxes[r]![c] === null && boxComplete(h, v, r, c)) boxes[r]![c] = edge.by
    }
  }
  return { h, v, boxes }
}

function isDrawn(board: Board, { row, col, orientation }: DotsAndBoxesMove): boolean {
  return (orientation === 'h' ? board.h : board.v)[row]![col] !== null
}

function scores(boxes: Grid): [number, number] {
  const flat = boxes.flat()
  return [flat.filter((b) => b === 0).length, flat.filter((b) => b === 1).length]
}

export const dotsandboxes: GameEngine<DotsAndBoxesState, DotsAndBoxesMove> = {
  init(_options, players) {
    return { players, turn: players[0], drawn: [] }
  },

  validate(state, by, move) {
    if (dotsandboxes.status(state).phase !== 'ongoing') return { ok: false, reason: 'the game is already over' }
    if (!state.players.includes(by)) return { ok: false, reason: 'not a player in this game' }
    if (by !== state.turn) return { ok: false, reason: 'not your turn' }
    const edge = parseEdge(move)
    if (!edge) {
      return {
        ok: false,
        reason: `move must be { row, col, orientation } with h: row 0..${BOX_ROWS}, col 0..${BOX_COLUMNS - 1} or v: row 0..${BOX_ROWS - 1}, col 0..${BOX_COLUMNS}`,
      }
    }
    if (isDrawn(derive(state.drawn), edge)) {
      return { ok: false, reason: `edge ${edge.orientation}(${edge.row}, ${edge.col}) is already drawn` }
    }
    return { ok: true }
  },

  apply(state, by, move) {
    const edge = parseEdge(move)
    if (!edge) throw new Error('malformed edge')
    const before = derive(state.drawn)
    if (isDrawn(before, edge)) throw new Error('edge already drawn')
    const idx = state.players.indexOf(by) as 0 | 1
    const drawn = [...state.drawn, { row: edge.row, col: edge.col, orientation: edge.orientation, by: idx }]
    // Claiming at least one box keeps the turn; otherwise it passes (GAME-023).
    const after = derive(drawn)
    const claimed = adjacentBoxes(edge).some(([r, c]) => before.boxes[r]![c] === null && after.boxes[r]![c] !== null)
    return { players: state.players, turn: claimed ? by : state.players[(1 - idx) as 0 | 1], drawn }
  },

  status(state) {
    if (state.drawn.length < EDGE_COUNT) return { phase: 'ongoing' }
    const [a, b] = scores(derive(state.drawn).boxes)
    if (a === b) return { phase: 'draw' }
    return { phase: 'won', winner: state.players[a > b ? 0 : 1] }
  },

  /** Viewerless: nothing is hidden. `owners[v]` is the profile behind edge/box value `v`. */
  view(state, _viewer?: ProfileId) {
    const { h, v, boxes } = derive(state.drawn)
    return {
      h,
      v,
      boxes,
      scores: scores(boxes),
      owners: [state.players[0], state.players[1]],
      turn: state.turn,
      players: state.players,
    }
  },
}
