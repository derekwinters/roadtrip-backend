import { describe, expect, it } from 'vitest'
import { tictactoe, type TttState } from '../../../src/games/engines/tictactoe.js'

const A = 'creator-profile'
const B = 'joiner-profile'

const start = (): TttState => tictactoe.init({}, [A, B])

function play(state: TttState, moves: Array<[string, number]>): TttState {
  let s = state
  for (const [by, cell] of moves) {
    const v = tictactoe.validate(s, by, { cell })
    if (!v.ok) throw new Error(`scripted move rejected: ${v.reason}`)
    s = tictactoe.apply(s, by, { cell })
  }
  return s
}

describe('tic-tac-toe engine', () => {
  it('creator plays X and moves first [GAME-017]', () => {
    const s = start()
    expect(s.turn).toBe(A)
    const after = play(s, [[A, 4]])
    expect(after.cells[4]).toBe(0)
    expect(after.turn).toBe(B)
    const view = tictactoe.view(after) as { board: (string | null)[] }
    expect(view.board[4]).toBe('X')
  })

  it('detects wins on rows, columns and diagonals [GAME-017]', () => {
    const row = play(start(), [[A, 0], [B, 3], [A, 1], [B, 4], [A, 2]])
    expect(tictactoe.status(row)).toEqual({ phase: 'won', winner: A })

    const col = play(start(), [[A, 0], [B, 1], [A, 3], [B, 2], [A, 6]])
    expect(tictactoe.status(col)).toEqual({ phase: 'won', winner: A })

    const diag = play(start(), [[A, 0], [B, 1], [A, 4], [B, 2], [A, 8]])
    expect(tictactoe.status(diag)).toEqual({ phase: 'won', winner: A })

    const oWins = play(start(), [[A, 0], [B, 3], [A, 1], [B, 4], [A, 8], [B, 5]])
    expect(tictactoe.status(oWins)).toEqual({ phase: 'won', winner: B })
  })

  it('draws on a full board with no winner [GAME-017]', () => {
    const s = play(start(), [[A, 0], [B, 4], [A, 8], [B, 1], [A, 7], [B, 6], [A, 2], [B, 5], [A, 3]])
    expect(tictactoe.status(s)).toEqual({ phase: 'draw' })
  })

  it('rejects occupied cells, out-of-range cells and malformed moves [GAME-017]', () => {
    const s = play(start(), [[A, 4]])
    const occupied = tictactoe.validate(s, B, { cell: 4 })
    expect(occupied.ok).toBe(false)
    if (!occupied.ok) expect(occupied.reason).toMatch(/taken/i)
    expect(tictactoe.validate(s, B, { cell: 9 }).ok).toBe(false)
    expect(tictactoe.validate(s, B, { cell: -1 }).ok).toBe(false)
    expect(tictactoe.validate(s, B, {} as never).ok).toBe(false)
    expect(tictactoe.validate(s, B, { cell: 1.5 }).ok).toBe(false)
  })

  it('rejects out-of-turn moves and moves after the game is over', () => {
    const s = start()
    expect(tictactoe.validate(s, B, { cell: 0 }).ok).toBe(false)
    expect(tictactoe.validate(s, 'someone-else', { cell: 0 }).ok).toBe(false)
    const done = play(s, [[A, 0], [B, 3], [A, 1], [B, 4], [A, 2]])
    expect(tictactoe.validate(done, B, { cell: 8 }).ok).toBe(false)
  })
})
