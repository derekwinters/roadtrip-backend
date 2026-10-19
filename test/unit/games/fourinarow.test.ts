import { describe, expect, it } from 'vitest'
import { fourinarow, type FourInARowState } from '../../../src/games/engines/fourinarow.js'

const A = 'creator-profile'
const B = 'joiner-profile'

const start = (): FourInARowState => fourinarow.init({}, [A, B])

/** Plays alternating columns starting with whoever is to move (A first from `start()`). */
function play(state: FourInARowState, columns: number[]): FourInARowState {
  let s = state
  for (const column of columns) {
    const by = s.turn
    const v = fourinarow.validate(s, by, { column })
    if (!v.ok) throw new Error(`scripted move rejected: ${v.reason}`)
    s = fourinarow.apply(s, by, { column })
  }
  return s
}

interface View {
  board: (0 | 1 | null)[][]
  discs: [string, string]
  turn: string
  players: [string, string]
}

const cell = (view: View, row: number, column: number) => view.board[row]?.[column]

describe('Four in a Row engine', () => {
  it('starts with an empty 6-row by 7-column board and the creator to move [GAME-020]', () => {
    const s = start()
    expect(s.turn).toBe(A)
    expect(fourinarow.status(s)).toEqual({ phase: 'ongoing' })
    const view = fourinarow.view(s) as View
    expect(view.board).toHaveLength(6)
    for (const row of view.board) expect(row).toEqual([null, null, null, null, null, null, null])
    expect(view.discs).toEqual([A, B])
    expect(view.players).toEqual([A, B])
    expect(view.turn).toBe(A)
  })

  it('drops a disc into the lowest empty row of its column (row 0 = bottom) [GAME-020]', () => {
    const one = play(start(), [3])
    expect(one.turn).toBe(B)
    let view = fourinarow.view(one) as View
    expect(cell(view, 0, 3)).toBe(0)
    expect(cell(view, 1, 3)).toBeNull()

    const three = play(one, [3, 3])
    view = fourinarow.view(three) as View
    expect(cell(view, 0, 3)).toBe(0)
    expect(cell(view, 1, 3)).toBe(1)
    expect(cell(view, 2, 3)).toBe(0)
    expect(cell(view, 3, 3)).toBeNull()
    expect(view.turn).toBe(B)
  })

  it('does not mutate the input state [GAME-020]', () => {
    const s = start()
    const snapshot = JSON.parse(JSON.stringify(s))
    fourinarow.apply(s, A, { column: 0 })
    expect(s).toEqual(snapshot)
  })

  it('detects a horizontal win for each player [GAME-020]', () => {
    // A: 0,1,2,3 on the bottom row; B stacks on top of them.
    const aWins = play(start(), [0, 0, 1, 1, 2, 2, 3])
    expect(fourinarow.status(aWins)).toEqual({ phase: 'won', winner: A })

    // B blocks column 3 on the bottom row, then completes row 1 across columns 0..3.
    const bWins = play(start(), [0, 0, 1, 1, 2, 2, 6, 3, 6, 6, 6, 3])
    expect(fourinarow.status(bWins)).toEqual({ phase: 'won', winner: B })
  })

  it('detects a vertical win for each player [GAME-020]', () => {
    const aWins = play(start(), [0, 1, 0, 1, 0, 1, 0])
    expect(fourinarow.status(aWins)).toEqual({ phase: 'won', winner: A })

    const bWins = play(start(), [6, 1, 0, 1, 0, 1, 0, 1])
    expect(fourinarow.status(bWins)).toEqual({ phase: 'won', winner: B })
  })

  it('detects a rising diagonal (bottom-left to top-right) win for each player [GAME-020]', () => {
    // A on (0,0),(1,1),(2,2),(3,3).
    const aWins = play(start(), [0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3])
    expect(fourinarow.status(aWins)).toEqual({ phase: 'won', winner: A })

    // Same shape shifted one column right for B, with A opening in column 0.
    const bWins = play(start(), [0, 1, 2, 2, 3, 3, 4, 3, 4, 4, 6, 4])
    expect(fourinarow.status(bWins)).toEqual({ phase: 'won', winner: B })
  })

  it('detects a falling diagonal (top-left to bottom-right) win for each player [GAME-020]', () => {
    // A on (0,6),(1,5),(2,4),(3,3) — the mirror of the rising case.
    const aWins = play(start(), [6, 5, 5, 4, 4, 3, 4, 3, 3, 0, 3])
    expect(fourinarow.status(aWins)).toEqual({ phase: 'won', winner: A })

    const bWins = play(start(), [6, 5, 4, 4, 3, 3, 2, 3, 2, 2, 0, 2])
    expect(fourinarow.status(bWins)).toEqual({ phase: 'won', winner: B })
  })

  it('a full board with no line is a draw [GAME-020]', () => {
    // Columns filled in pairs (0,1), (2,3), (4,5), then 6. Each column alternates A/B
    // bottom to top, and the pair ordering shifts the phase so no line of four forms.
    const fill = (a: number, b: number) => [a, b, a, b, a, b, b, a, b, a, b, a]
    const cols = [...fill(0, 1), ...fill(2, 3), ...fill(4, 5)]
    let s = play(start(), cols)
    expect(fourinarow.status(s)).toEqual({ phase: 'ongoing' })
    s = play(s, [6, 6, 6, 6, 6, 6])
    const view = fourinarow.view(s) as View
    expect(view.board.flat().every((c) => c !== null)).toBe(true)
    expect(fourinarow.status(s)).toEqual({ phase: 'draw' })
  })

  it('rejects a full column, an out-of-range column and malformed moves [GAME-020]', () => {
    const full = play(start(), [2, 2, 2, 2, 2, 2])
    const rejected = fourinarow.validate(full, A, { column: 2 })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toMatch(/full/i)

    const s = start()
    expect(fourinarow.validate(s, A, { column: 7 }).ok).toBe(false)
    expect(fourinarow.validate(s, A, { column: -1 }).ok).toBe(false)
    expect(fourinarow.validate(s, A, { column: 1.5 }).ok).toBe(false)
    expect(fourinarow.validate(s, A, { column: '3' } as never).ok).toBe(false)
    expect(fourinarow.validate(s, A, {} as never).ok).toBe(false)
    expect(fourinarow.validate(s, A, null as never).ok).toBe(false)
    expect(fourinarow.validate(s, A, { cell: 3 } as never).ok).toBe(false)
  })

  it('rejects out-of-turn moves, non-players and moves after the game is over [GAME-020]', () => {
    const s = start()
    expect(fourinarow.validate(s, B, { column: 0 }).ok).toBe(false)
    expect(fourinarow.validate(s, 'someone-else', { column: 0 }).ok).toBe(false)
    const done = play(s, [0, 1, 0, 1, 0, 1, 0])
    expect(fourinarow.status(done).phase).toBe('won')
    expect(fourinarow.validate(done, B, { column: 6 }).ok).toBe(false)
  })

  it('records { column, row } with the landing row, and the row is advisory on re-apply [GAME-020]', () => {
    const s = play(start(), [4, 4])
    expect(fourinarow.record!(s, A, { column: 4 })).toEqual({ column: 4, row: 2 })
    expect(fourinarow.record!(start(), A, { column: 0 })).toEqual({ column: 0, row: 0 })

    // A recorded (or submitted) row never places the disc: gravity re-derives it.
    const viaRecorded = fourinarow.apply(s, A, { column: 4, row: 5 } as never)
    const viaColumn = fourinarow.apply(s, A, { column: 4 })
    expect(viaRecorded).toEqual(viaColumn)
    expect(cell(fourinarow.view(viaRecorded) as View, 2, 4)).toBe(0)
    expect(cell(fourinarow.view(viaRecorded) as View, 5, 4)).toBeNull()
  })
})
