import { describe, it, expect } from 'vitest'
import { CONFIG_DEFAULTS, gameEnabledKey, validateConfigPatch } from '../../src/config.js'
import { GAME_TYPES } from '../../src/games/registry.js'

/**
 * Family-wide game-type switches (docs/spec/05-config.md CFG-010, 08-games.md GAME-021).
 * The invariant: the key set is derived from the game type catalog, so it cannot drift.
 */
describe('game_<type>_enabled config keys', () => {
  it('every game type has exactly one game_<type>_enabled key, defaulting to true [CFG-010]', () => {
    for (const type of GAME_TYPES) {
      const key = gameEnabledKey(type)
      expect(key).toBe(`game_${type}_enabled`)
      expect((CONFIG_DEFAULTS as unknown as Record<string, unknown>)[key]).toBe(true)
    }
    const gameKeys = Object.keys(CONFIG_DEFAULTS).filter((k) => /^game_.+_enabled$/.test(k))
    expect(gameKeys.sort()).toEqual(GAME_TYPES.map((t) => `game_${t}_enabled`).sort())
  })

  it('accepts booleans and rejects non-booleans all-or-nothing [CFG-010] [CFG-002]', () => {
    expect(validateConfigPatch({ game_chess_enabled: false, game_fourinarow_enabled: true })).toEqual({
      game_chess_enabled: false,
      game_fourinarow_enabled: true,
    })
    for (const bad of ['false', 0, 1, null, {}]) {
      expect(() => validateConfigPatch({ game_hangman_enabled: false, game_chess_enabled: bad })).toThrow(
        /game_chess_enabled must be a boolean/,
      )
    }
    // A key for a type that does not exist is unknown.
    expect(() => validateConfigPatch({ game_poker_enabled: false })).toThrow(/Unknown config key/)
  })
})
