import { describe, expect, it } from 'vitest'
import { Chess } from 'chess.js'
import { chess, type ChessState, type ChessMove } from '../../../src/games/engines/chess.js'

const W = 'white-profile'
const B = 'black-profile'

const start = (): ChessState => chess.init({}, [W, B])

function play(state: ChessState, moves: ChessMove[]): ChessState {
  let s = state
  for (const move of moves) {
    const by = s.turn
    const v = chess.validate(s, by!, move)
    if (!v.ok) throw new Error(`scripted move rejected: ${v.reason}`)
    s = chess.apply(s, by!, move)
  }
  return s
}

const mv = (from: string, to: string, promotion?: string): ChessMove =>
  promotion ? { from, to, promotion } : { from, to }

describe('chess engine (chess.js-backed)', () => {
  it('accepts legal moves and alternates turns; creator is white [GAME-010]', () => {
    const s = start()
    expect(s.turn).toBe(W)
    const after = play(s, [mv('e2', 'e4')])
    expect(after.turn).toBe(B)
    expect(after.fen).toContain(' b ')
  })

  it('never accepts a move chess.js rejects, and surfaces a reason [GAME-010]', () => {
    const s = play(start(), [mv('e2', 'e4')])
    const illegal: ChessMove[] = [
      mv('d7', 'd3'), // pawn quadruple-step
      mv('b8', 'b6'), // knight moving like a rook
      mv('e8', 'e6'), // king teleport
      mv('h8', 'h4'), // rook jumping over its own pawn
    ]
    for (const m of illegal) {
      const v = chess.validate(s, B, m)
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.reason.length).toBeGreaterThan(0)
      // Cross-check: chess.js itself rejects the same move.
      const ref = new Chess()
      ref.move({ from: 'e2', to: 'e4' })
      expect(() => ref.move({ from: m.from, to: m.to })).toThrow()
    }
    // Moving the opponent's piece is rejected too.
    expect(chess.validate(s, B, mv('d2', 'd4')).ok).toBe(false)
  })

  it("detects checkmate via chess.js (fool's mate) [GAME-010]", () => {
    const s = play(start(), [mv('f2', 'f3'), mv('e7', 'e5'), mv('g2', 'g4'), mv('d8', 'h4')])
    expect(chess.status(s)).toEqual({ phase: 'won', winner: B })
    expect(chess.validate(s, W, mv('a2', 'a3')).ok).toBe(false)
  })

  it('detects stalemate as a draw via chess.js [GAME-010]', () => {
    // Sam Loyd's shortest stalemate (10 moves).
    const s = play(start(), [
      mv('e2', 'e3'), mv('a7', 'a5'), mv('d1', 'h5'), mv('a8', 'a6'),
      mv('h5', 'a5'), mv('h7', 'h5'), mv('a5', 'c7'), mv('a6', 'h6'),
      mv('h2', 'h4'), mv('f7', 'f6'), mv('c7', 'd7'), mv('e8', 'f7'),
      mv('d7', 'b7'), mv('d8', 'd3'), mv('b7', 'b8'), mv('d3', 'h7'),
      mv('b8', 'c8'), mv('f7', 'g6'), mv('c8', 'e6'),
    ])
    expect(chess.status(s)).toEqual({ phase: 'draw' })
  })

  it('handles promotion moves [GAME-010]', () => {
    const s = play(start(), [
      mv('a2', 'a4'), mv('b7', 'b5'), mv('a4', 'b5'), mv('a7', 'a6'),
      mv('b5', 'a6'), mv('b8', 'c6'), mv('a6', 'a7'), mv('a8', 'b8'),
      mv('a7', 'b8', 'q'),
    ])
    expect(s.fen.split(' ')[0]).toMatch(/^1Q/)
    expect(chess.status(s)).toEqual({ phase: 'ongoing' })
  })

  it('rejects malformed move payloads with a reason [GAME-010]', () => {
    const s = start()
    for (const bad of [{ from: 'e2' }, { from: 'z9', to: 'e4' }, { from: 'e2', to: 'e4', promotion: 'x' }, {}, null]) {
      const v = chess.validate(s, W, bad as never)
      expect(v.ok).toBe(false)
    }
  })
})
