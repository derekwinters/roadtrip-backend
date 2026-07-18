import { describe, expect, it } from 'vitest'
import { checkers, type CheckersCell, type CheckersState } from '../../../src/games/engines/checkers.js'

// Player 0 (creator) starts on rows 0..2 and moves down (+r);
// player 1 (joiner) starts on rows 5..7 and moves up (-r).
const A = 'top-profile'
const B = 'bottom-profile'

const m0: CheckersCell = { p: 0, k: false }
const m1: CheckersCell = { p: 1, k: false }
const k0: CheckersCell = { p: 0, k: true }
const k1: CheckersCell = { p: 1, k: true }

function emptyBoard(): CheckersCell[][] {
  return Array.from({ length: 8 }, () => Array<CheckersCell>(8).fill(null))
}

function craft(pieces: Array<[number, number, CheckersCell]>, partial: Partial<CheckersState> = {}): CheckersState {
  const board = emptyBoard()
  for (const [r, c, cell] of pieces) board[r]![c] = cell
  return { players: [A, B], turn: A, board, continuation: null, quietPlies: 0, ...partial }
}

describe('checkers engine (American rules)', () => {
  it('sets up 12 men per side on dark squares with the creator to move [GAME-011]', () => {
    const s = checkers.init({}, [A, B])
    expect(s.turn).toBe(A)
    let p0 = 0
    let p1 = 0
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const cell = s.board[r]![c]
        if (!cell) continue
        expect((r + c) % 2).toBe(1) // dark squares only
        if (cell.p === 0) p0++
        else p1++
        expect(cell.k).toBe(false)
      }
    }
    expect(p0).toBe(12)
    expect(p1).toBe(12)
    // A basic diagonal opening move is legal.
    expect(checkers.validate(s, A, { from: [2, 1], to: [3, 2] }).ok).toBe(true)
    // Straight-ahead is not.
    expect(checkers.validate(s, A, { from: [2, 1], to: [3, 1] }).ok).toBe(false)
  })

  it('forces captures when one is available [GAME-011]', () => {
    const s = craft([
      [2, 1, m0],
      [3, 2, m1],
      [2, 5, m0], // this piece has a free simple move
    ])
    const simple = checkers.validate(s, A, { from: [2, 5], to: [3, 6] })
    expect(simple.ok).toBe(false)
    if (!simple.ok) expect(simple.reason).toMatch(/capture/i)
    expect(checkers.validate(s, A, { from: [2, 1], to: [4, 3] }).ok).toBe(true)
  })

  it('continues multi-jumps with the same piece and the same player [GAME-011]', () => {
    const s = craft([
      [2, 1, m0],
      [2, 7, m0],
      [3, 2, m1],
      [5, 4, m1],
      [7, 0, m1],
    ])
    const afterFirst = checkers.apply(s, A, { from: [2, 1], to: [4, 3] })
    expect(afterFirst.board[3]![2]).toBeNull() // captured
    expect(afterFirst.turn).toBe(A) // same player continues
    expect(afterFirst.continuation).toEqual([4, 3])
    // Only the jumping piece may move, and only to capture.
    expect(checkers.validate(afterFirst, A, { from: [2, 7], to: [3, 6] }).ok).toBe(false)
    expect(checkers.validate(afterFirst, A, { from: [4, 3], to: [5, 2] }).ok).toBe(false)
    const second = checkers.validate(afterFirst, A, { from: [4, 3], to: [6, 5] })
    expect(second.ok).toBe(true)
    const done = checkers.apply(afterFirst, A, { from: [4, 3], to: [6, 5] })
    expect(done.board[5]![4]).toBeNull()
    expect(done.continuation).toBeNull()
    expect(done.turn).toBe(B)
  })

  it('kings move and capture backwards; men never do [GAME-011]', () => {
    // No captures anywhere: king may step backwards, man may not.
    const quiet = craft([
      [5, 4, k0],
      [5, 0, m0],
      [7, 6, m1],
    ])
    expect(checkers.validate(quiet, A, { from: [5, 4], to: [4, 3] }).ok).toBe(true)
    expect(checkers.validate(quiet, A, { from: [5, 0], to: [4, 1] }).ok).toBe(false)

    // King captures backwards (towards row 0 for player 0).
    const cap = craft([
      [5, 4, k0],
      [4, 3, m1],
      [7, 0, m1],
    ])
    const v = checkers.validate(cap, A, { from: [5, 4], to: [3, 2] })
    expect(v.ok).toBe(true)
    const after = checkers.apply(cap, A, { from: [5, 4], to: [3, 2] })
    expect(after.board[4]![3]).toBeNull()

    // A man may not capture backwards even when that is the only capture.
    const backOnly = craft([[5, 4, m0], [4, 3, m1], [7, 0, m1]])
    expect(checkers.validate(backOnly, A, { from: [5, 4], to: [3, 2] }).ok).toBe(false)
  })

  it('crowns a man reaching the far row and ends the turn even if more jumps exist [GAME-011]', () => {
    const s = craft([
      [5, 2, m0],
      [6, 3, m1],
      [6, 5, m1],
    ])
    const after = checkers.apply(s, A, { from: [5, 2], to: [7, 4] })
    expect(after.board[7]![4]).toEqual({ p: 0, k: true })
    expect(after.board[6]![3]).toBeNull()
    expect(after.continuation).toBeNull() // crowning ends the turn
    expect(after.turn).toBe(B)
  })

  it('draws after 40 quiet plies without a capture or man advance [GAME-011]', () => {
    const kings = craft([[0, 1, k0], [7, 6, k1]], { quietPlies: 39 })
    const drawn = checkers.apply(kings, A, { from: [0, 1], to: [1, 0] })
    expect(drawn.quietPlies).toBe(40)
    expect(checkers.status(drawn)).toEqual({ phase: 'draw' })

    // A man advance resets the counter.
    const withMan = craft([[0, 1, k0], [2, 3, m0], [7, 6, k1]], { quietPlies: 39 })
    const reset = checkers.apply(withMan, A, { from: [2, 3], to: [3, 4] })
    expect(reset.quietPlies).toBe(0)
    expect(checkers.status(reset)).toEqual({ phase: 'ongoing' })
  })

  it('wins when the player to move has no pieces or no legal moves [GAME-011]', () => {
    const noPieces = craft([[0, 1, k0]], { turn: B })
    expect(checkers.status(noPieces)).toEqual({ phase: 'won', winner: A })

    // B's only man is fully blocked: forward square occupied, jump landing occupied.
    const blocked = craft([
      [7, 0, m1],
      [6, 1, m0],
      [5, 2, m0],
    ], { turn: B })
    expect(checkers.status(blocked)).toEqual({ phase: 'won', winner: A })
  })
})
