import { z } from 'zod'
import type { BaseState, GameEngine } from '../types.js'

/**
 * Checkers, American rules (GAME-011): 8×8 board, play on dark squares only
 * ((r + c) % 2 === 1), captures are forced, multi-jumps continue with the same piece,
 * kings move and capture backwards, men only forwards (including captures).
 *
 * Orientation: player 0 (the creator) starts on rows 0..2 and moves down (+r);
 * player 1 starts on rows 5..7 and moves up (-r). A man is crowned on reaching the
 * opponent's back row, which ends the turn even if further jumps would exist.
 *
 * Draw rule: 40 consecutive plies without a capture or a man move ("40 moves pass
 * without a capture or man advance"; a man can only move forward, so every man move
 * is an advance). Threefold-repetition draws are intentionally NOT implemented — the
 * spec marks repetition as an alternative trigger and the 40-ply counter already
 * bounds shuffling endgames.
 */

export type CheckersCell = { p: 0 | 1; k: boolean } | null

export interface CheckersMove {
  from: [number, number]
  to: [number, number]
}

export interface CheckersState extends BaseState {
  board: CheckersCell[][]
  /** Square of the piece that must keep jumping mid multi-capture, else null. */
  continuation: [number, number] | null
  /** Plies since the last capture or man move; 40 is a draw. */
  quietPlies: number
}

const coord = z.tuple([z.number().int().min(0).max(7), z.number().int().min(0).max(7)])
const moveSchema = z.object({ from: coord, to: coord })

const QUIET_PLY_DRAW_LIMIT = 40

const inBounds = (r: number, c: number): boolean => r >= 0 && r < 8 && c >= 0 && c < 8

function at(board: CheckersCell[][], r: number, c: number): CheckersCell {
  return inBounds(r, c) ? board[r]![c]! : null
}

/** Move directions: men only forward (player 0 down, player 1 up); kings all four. */
function dirsFor(cell: { p: 0 | 1; k: boolean }): Array<[number, number]> {
  if (cell.k) {
    return [
      [1, -1],
      [1, 1],
      [-1, -1],
      [-1, 1],
    ]
  }
  return cell.p === 0
    ? [
        [1, -1],
        [1, 1],
      ]
    : [
        [-1, -1],
        [-1, 1],
      ]
}

function capturesFrom(board: CheckersCell[][], r: number, c: number): Array<[number, number]> {
  const piece = at(board, r, c)
  if (!piece) return []
  const out: Array<[number, number]> = []
  for (const [dr, dc] of dirsFor(piece)) {
    const mid = at(board, r + dr, c + dc)
    if (mid && mid.p !== piece.p && inBounds(r + 2 * dr, c + 2 * dc) && at(board, r + 2 * dr, c + 2 * dc) === null) {
      out.push([r + 2 * dr, c + 2 * dc])
    }
  }
  return out
}

function stepsFrom(board: CheckersCell[][], r: number, c: number): Array<[number, number]> {
  const piece = at(board, r, c)
  if (!piece) return []
  const out: Array<[number, number]> = []
  for (const [dr, dc] of dirsFor(piece)) {
    if (inBounds(r + dr, c + dc) && at(board, r + dr, c + dc) === null) out.push([r + dr, c + dc])
  }
  return out
}

function anyCapture(board: CheckersCell[][], p: 0 | 1): boolean {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = board[r]![c]
      if (cell && cell.p === p && capturesFrom(board, r, c).length > 0) return true
    }
  }
  return false
}

function hasAnyMove(board: CheckersCell[][], p: 0 | 1): boolean {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = board[r]![c]
      if (cell && cell.p === p && (capturesFrom(board, r, c).length > 0 || stepsFrom(board, r, c).length > 0)) {
        return true
      }
    }
  }
  return false
}

function pieceCount(board: CheckersCell[][], p: 0 | 1): number {
  let n = 0
  for (const row of board) for (const cell of row) if (cell && cell.p === p) n++
  return n
}

export const checkers: GameEngine<CheckersState, CheckersMove> = {
  init(_options, players) {
    const board: CheckersCell[][] = Array.from({ length: 8 }, () => Array<CheckersCell>(8).fill(null))
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if ((r + c) % 2 !== 1) continue
        if (r <= 2) board[r]![c] = { p: 0, k: false }
        else if (r >= 5) board[r]![c] = { p: 1, k: false }
      }
    }
    return { players, turn: players[0], board, continuation: null, quietPlies: 0 }
  },

  validate(state, by, move) {
    if (checkers.status(state).phase !== 'ongoing') return { ok: false, reason: 'the game is already over' }
    if (!state.players.includes(by)) return { ok: false, reason: 'not a player in this game' }
    if (by !== state.turn) return { ok: false, reason: 'not your turn' }
    const parsed = moveSchema.safeParse(move)
    if (!parsed.success) return { ok: false, reason: 'move must be { from: [r,c], to: [r,c] } with 0..7 coordinates' }
    const { from, to } = parsed.data
    const me = state.players.indexOf(by) as 0 | 1
    const piece = at(state.board, from[0], from[1])
    if (!piece || piece.p !== me) return { ok: false, reason: 'no piece of yours on the from square' }
    if (at(state.board, to[0], to[1]) !== null) return { ok: false, reason: 'destination square is occupied' }
    if ((to[0] + to[1]) % 2 !== 1) return { ok: false, reason: 'play stays on the dark squares' }

    const dr = to[0] - from[0]
    const dc = to[1] - from[1]

    if (state.continuation) {
      if (from[0] !== state.continuation[0] || from[1] !== state.continuation[1]) {
        return { ok: false, reason: 'you must keep jumping with the same piece' }
      }
      if (Math.abs(dr) !== 2 || Math.abs(dc) !== 2) {
        return { ok: false, reason: 'you must continue the multi-jump with another capture' }
      }
    }

    if (Math.abs(dr) === 2 && Math.abs(dc) === 2) {
      if (!dirsFor(piece).some(([r, c]) => r === dr / 2 && c === dc / 2)) {
        return { ok: false, reason: piece.k ? 'illegal capture direction' : 'men only capture forwards' }
      }
      const mid = at(state.board, from[0] + dr / 2, from[1] + dc / 2)
      if (!mid || mid.p === me) return { ok: false, reason: 'a capture must jump over an opposing piece' }
      return { ok: true }
    }

    if (Math.abs(dr) === 1 && Math.abs(dc) === 1) {
      if (!dirsFor(piece).some(([r, c]) => r === dr && c === dc)) {
        return { ok: false, reason: piece.k ? 'illegal direction' : 'men only move forwards' }
      }
      if (anyCapture(state.board, me)) {
        return { ok: false, reason: 'a capture is available — captures are forced' }
      }
      return { ok: true }
    }

    return { ok: false, reason: 'moves go one square diagonally, or two when capturing' }
  },

  apply(state, by, move) {
    const { from, to } = moveSchema.parse(move)
    const me = state.players.indexOf(by) as 0 | 1
    const board = state.board.map((row) => row.slice())
    const piece = { ...board[from[0]]![from[1]]! }
    board[from[0]]![from[1]] = null

    const captured = Math.abs(to[0] - from[0]) === 2
    if (captured) board[(from[0] + to[0]) / 2]![(from[1] + to[1]) / 2] = null

    const crowned = !piece.k && (me === 0 ? to[0] === 7 : to[0] === 0)
    if (crowned) piece.k = true
    board[to[0]]![to[1]] = piece

    // Multi-jump: the same piece keeps capturing unless it was just crowned
    // (crowning ends the turn in American checkers).
    const continues = captured && !crowned && capturesFrom(board, to[0], to[1]).length > 0
    return {
      players: state.players,
      turn: continues ? by : state.players[(1 - me) as 0 | 1],
      board,
      continuation: continues ? [to[0], to[1]] : null,
      quietPlies: captured || !piece.k || crowned ? 0 : state.quietPlies + 1,
    }
  },

  status(state) {
    if (state.quietPlies >= QUIET_PLY_DRAW_LIMIT) return { phase: 'draw' }
    const toMove = state.players.indexOf(state.turn) as 0 | 1
    if (pieceCount(state.board, toMove) === 0 || !hasAnyMove(state.board, toMove)) {
      return { phase: 'won', winner: state.players[(1 - toMove) as 0 | 1] }
    }
    return { phase: 'ongoing' }
  },

  view(state) {
    return {
      board: state.board,
      turn: state.turn,
      players: state.players,
      must_continue_from: state.continuation,
      quiet_plies: state.quietPlies,
    }
  },
}
