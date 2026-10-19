import { describe, expect, it } from 'vitest'
import { dotsandboxes, type DotsAndBoxesMove, type DotsAndBoxesState } from '../../../src/games/engines/dotsandboxes.js'
import { creatorWinsGame, drawGame, joinerWinsGame, type ScriptedMove } from '../../helpers/dotsandboxes.js'

const A = 'creator-profile'
const B = 'joiner-profile'

const start = (): DotsAndBoxesState => dotsandboxes.init({}, [A, B])

const h = (row: number, col: number): DotsAndBoxesMove => ({ row, col, orientation: 'h' })
const v = (row: number, col: number): DotsAndBoxesMove => ({ row, col, orientation: 'v' })

/** Plays each edge as whoever is to move — turns follow the engine, not strict alternation. */
function play(state: DotsAndBoxesState, edges: DotsAndBoxesMove[]): DotsAndBoxesState {
  let s = state
  for (const edge of edges) {
    const by = s.turn
    const verdict = dotsandboxes.validate(s, by, edge)
    if (!verdict.ok) throw new Error(`scripted move ${JSON.stringify(edge)} rejected: ${verdict.reason}`)
    s = dotsandboxes.apply(s, by, edge)
  }
  return s
}

interface View {
  h: (0 | 1 | null)[][]
  v: (0 | 1 | null)[][]
  boxes: (0 | 1 | null)[][]
  scores: [number, number]
  owners: [string, string]
  turn: string
  players: [string, string]
}
const view = (s: DotsAndBoxesState) => dotsandboxes.view(s) as View

const edges = (script: ScriptedMove[]) => script.map(([, edge]) => edge)
const DRAW_21_21 = edges(drawGame())
const CREATOR_WINS_35_7 = edges(creatorWinsGame())
const JOINER_WINS_0_42 = edges(joinerWinsGame())

describe('Dots and Boxes engine', () => {
  it('starts with no edges drawn, no boxes claimed and the creator to move [GAME-023]', () => {
    const s = start()
    expect(s.turn).toBe(A)
    expect(dotsandboxes.status(s)).toEqual({ phase: 'ongoing' })
    const vw = view(s)
    expect(vw.h).toHaveLength(7)
    for (const row of vw.h) expect(row).toEqual(Array(7).fill(null))
    expect(vw.v).toHaveLength(6)
    for (const row of vw.v) expect(row).toEqual(Array(8).fill(null))
    expect(vw.boxes).toHaveLength(6)
    for (const row of vw.boxes) expect(row).toEqual(Array(7).fill(null))
    expect(vw.scores).toEqual([0, 0])
    expect(vw.owners).toEqual([A, B])
    expect(vw.players).toEqual([A, B])
    expect(vw.turn).toBe(A)
  })

  it('an edge that completes no box passes the turn [GAME-023]', () => {
    const s = play(start(), [h(0, 0)])
    expect(s.turn).toBe(B)
    const vw = view(s)
    expect(vw.h[0]![0]).toBe(0)
    expect(vw.boxes.flat().every((b) => b === null)).toBe(true)
    expect(play(s, [v(3, 3)]).turn).toBe(A)
    expect(view(play(s, [v(3, 3)])).v[3]![3]).toBe(1)
  })

  it('an edge that completes a box claims it for the mover, who keeps the turn [GAME-023]', () => {
    // Box (2,3) = h(2,3) top, h(3,3) bottom, v(2,3) left, v(2,4) right. A, B, A draw three sides.
    const three = play(start(), [h(2, 3), h(3, 3), v(2, 3)])
    expect(three.turn).toBe(B)
    const four = play(three, [v(2, 4)])
    expect(four.turn).toBe(B) // B claimed, so B moves again
    const vw = view(four)
    expect(vw.boxes[2]![3]).toBe(1)
    expect(vw.boxes.flat().filter((b) => b !== null)).toHaveLength(1)
    expect(vw.scores).toEqual([0, 1])
    expect(dotsandboxes.status(four)).toEqual({ phase: 'ongoing' })

    // B keeps going: a non-claiming edge then hands the turn back.
    expect(play(four, [h(0, 0)]).turn).toBe(A)
  })

  it('one edge completing two boxes claims both and keeps the turn [GAME-023]', () => {
    // Boxes (0,0) and (0,1) share v(0,1). Draw the six other sides (A,B,A,B,A,B), then A draws v(0,1).
    const six = play(start(), [h(0, 0), h(1, 0), v(0, 0), h(0, 1), h(1, 1), v(0, 2)])
    expect(six.turn).toBe(A)
    expect(view(six).scores).toEqual([0, 0])
    const both = play(six, [v(0, 1)])
    expect(both.turn).toBe(A)
    const vw = view(both)
    expect(vw.boxes[0]!.slice(0, 2)).toEqual([0, 0])
    expect(vw.scores).toEqual([2, 0])

    // Same with a horizontal edge: boxes (3,5) and (4,5) share h(4,5).
    const sides = play(start(), [h(3, 5), v(3, 5), v(3, 6), h(5, 5), v(4, 5), v(4, 6)])
    expect(sides.turn).toBe(A)
    const stacked = play(sides, [h(4, 5)])
    expect(stacked.turn).toBe(A)
    expect(view(stacked).boxes[3]![5]).toBe(0)
    expect(view(stacked).boxes[4]![5]).toBe(0)
  })

  it('does not mutate the input state [GAME-023]', () => {
    const s = play(start(), [h(0, 0), h(1, 0), v(0, 0)])
    const snapshot = JSON.parse(JSON.stringify(s))
    dotsandboxes.apply(s, B, v(0, 1))
    expect(s).toEqual(snapshot)
  })

  it('rejects an already-drawn edge, out-of-range edges and malformed moves [GAME-023]', () => {
    const s = play(start(), [h(0, 0)])
    const dup = dotsandboxes.validate(s, B, h(0, 0))
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.reason).toMatch(/already/i)
    // The same coordinates in the other orientation are a different edge.
    expect(dotsandboxes.validate(s, B, v(0, 0)).ok).toBe(true)

    const fresh = start()
    for (const bad of [h(7, 0), h(0, 7), h(-1, 0), v(6, 0), v(0, 8), v(0, -1)]) {
      expect(dotsandboxes.validate(fresh, A, bad).ok, JSON.stringify(bad)).toBe(false)
    }
    // In range for one orientation but not the other.
    expect(dotsandboxes.validate(fresh, A, h(6, 6)).ok).toBe(true)
    expect(dotsandboxes.validate(fresh, A, v(6, 6)).ok).toBe(false)
    expect(dotsandboxes.validate(fresh, A, v(5, 7)).ok).toBe(true)
    expect(dotsandboxes.validate(fresh, A, h(5, 7)).ok).toBe(false)

    for (const bad of [
      { row: 0, col: 0 },
      { row: 0, col: 0, orientation: 'd' },
      { row: 0.5, col: 0, orientation: 'h' },
      { row: '0', col: 0, orientation: 'h' },
      { cell: 3 },
      { column: 3 },
      {},
      null,
    ]) {
      expect(dotsandboxes.validate(fresh, A, bad as never).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('rejects out-of-turn moves, non-players and moves after the game is over [GAME-023]', () => {
    const s = start()
    expect(dotsandboxes.validate(s, B, h(0, 0)).ok).toBe(false)
    expect(dotsandboxes.validate(s, 'someone-else', h(0, 0)).ok).toBe(false)
    const done = play(s, DRAW_21_21)
    expect(dotsandboxes.status(done).phase).toBe('draw')
    expect(dotsandboxes.validate(done, done.turn, h(0, 0)).ok).toBe(false)
  })

  it('finishes only when all 97 edges are drawn; equal boxes is a draw [GAME-023]', () => {
    expect(DRAW_21_21).toHaveLength(97)
    const almost = play(start(), DRAW_21_21.slice(0, 96))
    expect(dotsandboxes.status(almost)).toEqual({ phase: 'ongoing' })
    const done = play(almost, DRAW_21_21.slice(96))
    const vw = view(done)
    expect(vw.h.flat().every((e) => e !== null)).toBe(true)
    expect(vw.v.flat().every((e) => e !== null)).toBe(true)
    expect(vw.boxes.flat().every((b) => b !== null)).toBe(true)
    expect(vw.scores).toEqual([21, 21])
    expect(vw.boxes.map((row) => row[0])).toEqual([0, 1, 0, 1, 0, 1])
    expect(dotsandboxes.status(done)).toEqual({ phase: 'draw' })
  })

  it('when all edges are drawn the player with more boxes wins [GAME-023]', () => {
    expect(CREATOR_WINS_35_7).toHaveLength(97)
    const creatorWins = play(start(), CREATOR_WINS_35_7)
    expect(view(creatorWins).scores).toEqual([35, 7])
    expect(dotsandboxes.status(creatorWins)).toEqual({ phase: 'won', winner: A })

    expect(JOINER_WINS_0_42).toHaveLength(97)
    const joinerWins = play(start(), JOINER_WINS_0_42)
    expect(view(joinerWins).scores).toEqual([0, 42])
    expect(dotsandboxes.status(joinerWins)).toEqual({ phase: 'won', winner: B })
  })

  it('a long chain keeps one player moving; refolding the moves reproduces the state [GAME-023] [GAME-006]', () => {
    // Replay the creator-wins script, recording who moved, then fold it again from scratch.
    let s = start()
    const log: Array<[string, DotsAndBoxesMove]> = []
    for (const edge of CREATOR_WINS_35_7) {
      log.push([s.turn, edge])
      s = dotsandboxes.apply(s, s.turn, edge)
    }
    // 54 alternating openers, then A makes 35 claims plus v(5,0) in a row (36 consecutive moves).
    const run = log.slice(54, 90).map(([by]) => by)
    expect(run).toEqual(Array(36).fill(A))
    expect(log[90]![0]).toBe(B)

    const refolded = log.reduce((acc, [by, edge]) => dotsandboxes.apply(acc, by, JSON.parse(JSON.stringify(edge))), start())
    expect(refolded).toEqual(s)
    expect(JSON.parse(JSON.stringify(refolded))).toEqual(refolded) // JSON round-trips (stored as jsonb)
  })

  it('the shared full-game scripts name the same mover as the engine on every move [GAME-023]', () => {
    for (const script of [drawGame(), creatorWinsGame(), joinerWinsGame()]) {
      let s = start()
      for (const [by, edge] of script) {
        expect(s.turn).toBe([A, B][by])
        s = dotsandboxes.apply(s, s.turn, edge)
      }
      expect(dotsandboxes.status(s).phase).not.toBe('ongoing')
    }
  })

  it('records the submitted edge unchanged (no record normalization) [GAME-023]', () => {
    expect(dotsandboxes.record).toBeUndefined()
  })
})
