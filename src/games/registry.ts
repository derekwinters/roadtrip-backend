import type { GameEngine } from './types.js'
import { chess } from './engines/chess.js'
import { checkers } from './engines/checkers.js'
import { tictactoe } from './engines/tictactoe.js'
import { ultimate } from './engines/ultimate.js'
import { hangman } from './engines/hangman.js'

/** The five turn-based games of docs/spec/08-games.md. */
export const GAME_TYPES = ['chess', 'checkers', 'tictactoe', 'ultimate', 'hangman'] as const
export type GameType = (typeof GAME_TYPES)[number]

/**
 * Engines are pure and stateless, so the registry maps each game type to a single
 * shared instance. The `any` erasure is deliberate: the service folds opaque event
 * payloads (GAME-006) and each engine re-validates its own state/move shapes.
 */
const engines: Record<GameType, GameEngine<any, any>> = {
  chess,
  checkers,
  tictactoe,
  ultimate,
  hangman,
}

export function getEngine(type: string): GameEngine<any, any> {
  const engine = engines[type as GameType]
  if (!engine) throw new Error(`unknown game type: ${type}`)
  return engine
}
