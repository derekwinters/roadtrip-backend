import { describe, expect, it } from 'vitest'
import { ultimate, type UltimateState } from '../../../src/games/engines/ultimate.js'

const A = 'creator-profile'
const B = 'joiner-profile'

function craft(partial: Partial<UltimateState> = {}): UltimateState {
  return {
    players: [A, B],
    turn: A,
    boards: Array.from({ length: 9 }, () => Array<0 | 1 | null>(9).fill(null)),
    macro: Array<0 | 1 | 'D' | null>(9).fill(null),
    nextBoard: null,
    ...partial,
  }
}

describe('ultimate tic-tac-toe engine', () => {
  it('first move is a free choice; afterwards the cell dictates the opponent sub-board [GAME-012]', () => {
    const s = ultimate.init({}, [A, B])
    expect(s.nextBoard).toBeNull()
    expect(ultimate.validate(s, A, { board: 4, cell: 1 }).ok).toBe(true)
    const after = ultimate.apply(s, A, { board: 4, cell: 1 })
    expect(after.nextBoard).toBe(1)
    expect(after.turn).toBe(B)
    const wrong = ultimate.validate(after, B, { board: 2, cell: 0 })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.reason).toMatch(/sub-board 1/)
    expect(ultimate.validate(after, B, { board: 1, cell: 4 }).ok).toBe(true)
  })

  it('gives free choice when the dictated sub-board is already decided [GAME-012]', () => {
    const boards = craft().boards
    boards[3] = [0, 0, 0, null, null, null, null, null, null]
    const s = craft({ boards, macro: [null, null, null, 0, null, null, null, null, null], nextBoard: 4 })
    // A plays into board 4, cell 3 — but sub-board 3 is already won, so B gets free choice.
    const after = ultimate.apply(s, A, { board: 4, cell: 3 })
    expect(after.nextBoard).toBeNull()
    expect(ultimate.validate(after, B, { board: 7, cell: 0 }).ok).toBe(true)
    // ...but never into a decided board.
    const intoWon = ultimate.validate(after, B, { board: 3, cell: 4 })
    expect(intoWon.ok).toBe(false)
    if (!intoWon.ok) expect(intoWon.reason).toMatch(/decided/i)
  })

  it('a full sub-board without a winner counts for neither side [GAME-012]', () => {
    const boards = craft().boards
    boards[0] = [0, 0, 1, 1, 1, 0, 0, 1, null] // filling cell 8 with 0 makes no line
    const s = craft({ boards, nextBoard: 0 })
    const after = ultimate.apply(s, A, { board: 0, cell: 8 })
    expect(after.macro[0]).toBe('D')
    expect(ultimate.status(after)).toEqual({ phase: 'ongoing' })
    // The drawn board can no longer be played.
    expect(ultimate.validate({ ...after, nextBoard: null }, B, { board: 0, cell: 8 }).ok).toBe(false)
  })

  it('wins the macro board with three sub-board wins in a row [GAME-012]', () => {
    const boards = craft().boards
    boards[2] = [0, 0, null, null, null, null, null, null, null]
    const s = craft({ boards, macro: [0, 0, null, null, null, null, null, null, null], nextBoard: 2 })
    const after = ultimate.apply(s, A, { board: 2, cell: 2 })
    expect(after.macro[2]).toBe(0)
    expect(ultimate.status(after)).toEqual({ phase: 'won', winner: A })
  })

  it('declares a draw when every sub-board is decided without a macro line [GAME-012]', () => {
    const s = craft({ macro: [0, 1, 0, 1, 'D', 1, 1, 0, 'D'] })
    expect(ultimate.status(s)).toEqual({ phase: 'draw' })
  })

  it('rejects occupied cells, malformed moves and out-of-turn play [GAME-012]', () => {
    const s = ultimate.init({}, [A, B])
    const one = ultimate.apply(s, A, { board: 4, cell: 4 })
    expect(ultimate.validate(one, B, { board: 4, cell: 4 }).ok).toBe(false) // occupied
    expect(ultimate.validate(one, A, { board: 4, cell: 0 }).ok).toBe(false) // out of turn
    expect(ultimate.validate(one, B, { board: 9, cell: 0 }).ok).toBe(false)
    expect(ultimate.validate(one, B, { board: 4 } as never).ok).toBe(false)
  })
})
