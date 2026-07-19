import { describe, expect, it } from 'vitest'
import { checkers, rcToSquare, squareToRC, type CheckersCell, type CheckersState } from '../../../src/games/engines/checkers.js'

// Player 0 (creator) starts on rows 0..2 (ranks 1-3) and moves down (+r);
// player 1 (joiner) starts on rows 5..7 (ranks 6-8) and moves up (-r).
// Moves are algebraic squares (file='a'+col, rank=row+1), same notation as chess.
const A = 'top-profile'
const B = 'bottom-profile'

const m0: CheckersCell = { p: 0, k: false }
const m1: CheckersCell = { p: 1, k: false }
const k0: CheckersCell = { p: 0, k: true }
const k1: CheckersCell = { p: 1, k: true }

/** Test-side algebraic helper mirroring the engine's [row,col]→square mapping. */
const sq = (r: number, c: number): string => rcToSquare(r, c)

function emptyBoard(): CheckersCell[][] {
  return Array.from({ length: 8 }, () => Array<CheckersCell>(8).fill(null))
}

function craft(pieces: Array<[number, number, CheckersCell]>, partial: Partial<CheckersState> = {}): CheckersState {
  const board = emptyBoard()
  for (const [r, c, cell] of pieces) board[r]![c] = cell
  return { players: [A, B], turn: A, board, continuation: null, quietPlies: 0, ...partial }
}

describe('checkers algebraic ↔ internal conversion [GAME-011]', () => {
  it('maps corners and the whole board so file=a+col, rank=row+1', () => {
    // covers: GAME-011
    expect(rcToSquare(0, 0)).toBe('a1')
    expect(rcToSquare(7, 7)).toBe('h8')
    expect(rcToSquare(2, 1)).toBe('b3')
    expect(rcToSquare(5, 4)).toBe('e6')
    expect(squareToRC('a1')).toEqual([0, 0])
    expect(squareToRC('h8')).toEqual([7, 7])
    expect(squareToRC('b3')).toEqual([2, 1])
    // Round-trips for every square.
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        expect(squareToRC(rcToSquare(r, c))).toEqual([r, c])
      }
    }
  })
})

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
    // A basic diagonal opening move is legal in algebraic form.
    expect(checkers.validate(s, A, { from: 'b3', to: 'c4' }).ok).toBe(true)
    // Straight-ahead is not.
    expect(checkers.validate(s, A, { from: 'b3', to: 'b4' }).ok).toBe(false)
  })

  it('accepts algebraic squares and rejects mis-shaped moves with a clear reason [GAME-004] [GAME-011]', () => {
    const s = checkers.init({}, [A, B])
    // Old numeric-tuple shape is now rejected.
    const tuple = checkers.validate(s, A, { from: [2, 1], to: [3, 2] } as unknown as { from: string; to: string })
    expect(tuple.ok).toBe(false)
    if (!tuple.ok) expect(tuple.reason).toMatch(/algebraic/i)
    // Out-of-range / malformed squares are rejected.
    const bad = checkers.validate(s, A, { from: 'z9', to: 'a1' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toMatch(/algebraic/i)
    // Missing field.
    const missing = checkers.validate(s, A, { from: 'b3' } as unknown as { from: string; to: string })
    expect(missing.ok).toBe(false)
  })

  it('forces captures when one is available [GAME-011]', () => {
    const s = craft([
      [2, 1, m0],
      [3, 2, m1],
      [2, 5, m0], // this piece has a free simple move
    ])
    const simple = checkers.validate(s, A, { from: sq(2, 5), to: sq(3, 6) })
    expect(simple.ok).toBe(false)
    if (!simple.ok) expect(simple.reason).toMatch(/capture/i)
    expect(checkers.validate(s, A, { from: sq(2, 1), to: sq(4, 3) }).ok).toBe(true)
  })

  it('continues multi-jumps with the same piece and the same player [GAME-011]', () => {
    const s = craft([
      [2, 1, m0],
      [2, 7, m0],
      [3, 2, m1],
      [5, 4, m1],
      [7, 0, m1],
    ])
    const afterFirst = checkers.apply(s, A, { from: sq(2, 1), to: sq(4, 3) })
    expect(afterFirst.board[3]![2]).toBeNull() // captured
    expect(afterFirst.turn).toBe(A) // same player continues
    expect(afterFirst.continuation).toEqual([4, 3])
    // Only the jumping piece may move, and only to capture.
    expect(checkers.validate(afterFirst, A, { from: sq(2, 7), to: sq(3, 6) }).ok).toBe(false)
    expect(checkers.validate(afterFirst, A, { from: sq(4, 3), to: sq(5, 2) }).ok).toBe(false)
    const second = checkers.validate(afterFirst, A, { from: sq(4, 3), to: sq(6, 5) })
    expect(second.ok).toBe(true)
    const done = checkers.apply(afterFirst, A, { from: sq(4, 3), to: sq(6, 5) })
    expect(done.board[5]![4]).toBeNull()
    expect(done.continuation).toBeNull()
    expect(done.turn).toBe(B)
  })

  it('records captured squares in the normalized move, and omits them for simple moves [GAME-011]', () => {
    // Capture: b3xc4 landing on d5 removes the man on c4.
    const s = craft([
      [2, 1, m0],
      [3, 2, m1],
    ])
    expect(checkers.record!(s, A, { from: sq(2, 1), to: sq(4, 3) })).toEqual({
      from: 'b3',
      to: 'd5',
      captured: ['c4'],
    })
    // Simple move: no captured field at all.
    const quiet = craft([[2, 1, m0]])
    expect(checkers.record!(quiet, A, { from: sq(2, 1), to: sq(3, 2) })).toEqual({ from: 'b3', to: 'c4' })
  })

  it('re-applying a recorded capturing move (with the captured field) reproduces the state [GAME-006] [GAME-011]', () => {
    const s = craft([
      [2, 1, m0],
      [3, 2, m1],
    ])
    const recorded = checkers.record!(s, A, { from: sq(2, 1), to: sq(4, 3) })
    // The fold receives the recorded move verbatim — captured must be ignored on apply.
    const applied = checkers.apply(s, A, recorded as { from: string; to: string })
    expect(applied.board[4]![3]).toEqual(m0)
    expect(applied.board[3]![2]).toBeNull() // captured man removed
    expect(applied.board[2]![1]).toBeNull()
  })

  it('kings move and capture backwards; men never do [GAME-011]', () => {
    // No captures anywhere: king may step backwards, man may not.
    const quiet = craft([
      [5, 4, k0],
      [5, 0, m0],
      [7, 6, m1],
    ])
    expect(checkers.validate(quiet, A, { from: sq(5, 4), to: sq(4, 3) }).ok).toBe(true)
    expect(checkers.validate(quiet, A, { from: sq(5, 0), to: sq(4, 1) }).ok).toBe(false)

    // King captures backwards (towards row 0 for player 0).
    const cap = craft([
      [5, 4, k0],
      [4, 3, m1],
      [7, 0, m1],
    ])
    const v = checkers.validate(cap, A, { from: sq(5, 4), to: sq(3, 2) })
    expect(v.ok).toBe(true)
    const after = checkers.apply(cap, A, { from: sq(5, 4), to: sq(3, 2) })
    expect(after.board[4]![3]).toBeNull()

    // A man may not capture backwards even when that is the only capture.
    const backOnly = craft([[5, 4, m0], [4, 3, m1], [7, 0, m1]])
    expect(checkers.validate(backOnly, A, { from: sq(5, 4), to: sq(3, 2) }).ok).toBe(false)
  })

  it('crowns a man reaching the far rank and ends the turn even if more jumps exist [GAME-011]', () => {
    const s = craft([
      [5, 2, m0],
      [6, 3, m1],
      [6, 5, m1],
    ])
    // c6 jumps d7 to land on e8 (rank 8 = player 0's crowning rank).
    expect(sq(7, 4)).toBe('e8')
    const after = checkers.apply(s, A, { from: sq(5, 2), to: sq(7, 4) })
    expect(after.board[7]![4]).toEqual({ p: 0, k: true })
    expect(after.board[6]![3]).toBeNull()
    expect(after.continuation).toBeNull() // crowning ends the turn
    expect(after.turn).toBe(B)
    // The recorded move carries the captured square; the client crowns by the rank-8 destination.
    expect(checkers.record!(s, A, { from: sq(5, 2), to: sq(7, 4) })).toEqual({
      from: 'c6',
      to: 'e8',
      captured: ['d7'],
    })
  })

  it('crowns player 1 on reaching rank 1 (row 0) [GAME-011]', () => {
    const s = craft([[2, 1, m1]], { turn: B })
    expect(sq(0, 0)).toBe('a1')
    const after = checkers.apply(s, B, { from: sq(2, 1), to: sq(1, 0) })
    // A simple advance to rank 2 does not crown yet.
    expect(after.board[1]![0]).toEqual({ p: 1, k: false })
    const crowned = craft([[1, 2, m1]], { turn: B })
    const done = checkers.apply(crowned, B, { from: sq(1, 2), to: sq(0, 1) })
    expect(done.board[0]![1]).toEqual({ p: 1, k: true })
  })

  it('draws after 40 quiet plies without a capture or man advance [GAME-011]', () => {
    const kings = craft([[0, 1, k0], [7, 6, k1]], { quietPlies: 39 })
    const drawn = checkers.apply(kings, A, { from: sq(0, 1), to: sq(1, 0) })
    expect(drawn.quietPlies).toBe(40)
    expect(checkers.status(drawn)).toEqual({ phase: 'draw' })

    // A man advance resets the counter.
    const withMan = craft([[0, 1, k0], [2, 3, m0], [7, 6, k1]], { quietPlies: 39 })
    const reset = checkers.apply(withMan, A, { from: sq(2, 3), to: sq(3, 4) })
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
