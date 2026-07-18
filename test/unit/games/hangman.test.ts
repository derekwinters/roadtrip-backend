import { describe, expect, it } from 'vitest'
import { hangman, validateHangmanOptions, type HangmanState } from '../../../src/games/engines/hangman.js'

const SETTER = 'setter-profile'
const GUESSER = 'guesser-profile'
const SPECTATOR = 'spectator-profile'

const start = (word: string, ignore = false): HangmanState =>
  hangman.init({ word, ignore_dictionary: ignore }, [SETTER, GUESSER])

function guess(state: HangmanState, letters: string): HangmanState {
  let s = state
  for (const letter of letters) {
    const v = hangman.validate(s, GUESSER, { letter })
    if (!v.ok) throw new Error(`scripted guess rejected: ${v.reason}`)
    s = hangman.apply(s, GUESSER, { letter })
  }
  return s
}

describe('hangman word validation (create time)', () => {
  it('accepts dictionary words and rejects gibberish by default [GAME-013]', () => {
    expect(validateHangmanOptions({ word: 'banana' }).ok).toBe(true)
    expect(validateHangmanOptions({ word: 'Banana' }).ok).toBe(true) // case-insensitive
    const bad = validateHangmanOptions({ word: 'qqqzz' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toMatch(/dictionary/i)
  })

  it('ignore_dictionary skips the dictionary but never the caps [GAME-013]', () => {
    expect(validateHangmanOptions({ word: 'qqqzz', ignore_dictionary: true }).ok).toBe(true)
    // Per-word cap of 15 letters holds even with the dictionary off.
    expect(validateHangmanOptions({ word: 'abcdefghijklmnop', ignore_dictionary: true }).ok).toBe(false)
    expect(validateHangmanOptions({ word: 'abcdefghijklmno', ignore_dictionary: true }).ok).toBe(true)
  })

  it('phrases skip the dictionary but are capped at 3 words / 30 letters [GAME-013]', () => {
    expect(validateHangmanOptions({ word: 'grand canyon' }).ok).toBe(true)
    expect(validateHangmanOptions({ word: 'the grand canyon' }).ok).toBe(true)
    expect(validateHangmanOptions({ word: 'one two three four' }).ok).toBe(false)
    // 3 words but 33 letters in total.
    expect(validateHangmanOptions({ word: 'abcdefghijk abcdefghijk abcdefghijk' }).ok).toBe(false)
  })

  it('allows only letters and spaces [GAME-013]', () => {
    expect(validateHangmanOptions({ word: 'route 66' }).ok).toBe(false)
    expect(validateHangmanOptions({ word: "don't" }).ok).toBe(false)
    expect(validateHangmanOptions({ word: '' }).ok).toBe(false)
    expect(validateHangmanOptions({ word: '   ' }).ok).toBe(false)
    expect(validateHangmanOptions({}).ok).toBe(false)
    expect(validateHangmanOptions({ word: 42 }).ok).toBe(false)
  })
})

describe('hangman engine', () => {
  it('the guesser always holds the turn; the setter never moves', () => {
    const s = start('banana')
    expect(s.turn).toBe(GUESSER)
    expect(hangman.validate(s, SETTER, { letter: 'a' }).ok).toBe(false)
  })

  it('the guesser wins by revealing every letter', () => {
    const s = guess(start('banana'), 'ban')
    expect(hangman.status(s)).toEqual({ phase: 'won', winner: GUESSER })
  })

  it('six wrong guesses win the game for the setter', () => {
    const five = guess(start('banana'), 'qwxzj')
    expect(five.wrong).toBe(5)
    expect(hangman.status(five)).toEqual({ phase: 'ongoing' })
    const six = guess(five, 'k')
    expect(hangman.status(six)).toEqual({ phase: 'won', winner: SETTER })
  })

  it('masks unguessed letters but shows spaces; the word never leaks to guesser or spectators [GAME-014]', () => {
    const s = guess(start('road trip'), 'r')
    const guesserView = hangman.view(s, GUESSER) as { display: string }
    expect(guesserView.display).toBe('r___ _r__')
    expect(JSON.stringify(guesserView)).not.toMatch(/road|trip/)
    const spectatorView = hangman.view(s, SPECTATOR) as { display: string }
    expect(spectatorView.display).toBe('r___ _r__')
    expect(JSON.stringify(spectatorView)).not.toMatch(/road|trip/)
    const setterView = hangman.view(s, SETTER) as { word?: string }
    expect(setterView.word).toBe('road trip')
  })

  it('reveals the word to everyone once the game is over [GAME-014]', () => {
    const lost = guess(start('road trip'), 'qwxzjk')
    const view = hangman.view(lost, GUESSER) as { word?: string }
    expect(view.word).toBe('road trip')
  })

  it('rejects repeated, multi-character and non-letter guesses', () => {
    const s = guess(start('banana'), 'b')
    expect(hangman.validate(s, GUESSER, { letter: 'b' }).ok).toBe(false)
    expect(hangman.validate(s, GUESSER, { letter: 'ab' }).ok).toBe(false)
    expect(hangman.validate(s, GUESSER, { letter: '1' }).ok).toBe(false)
    expect(hangman.validate(s, GUESSER, {} as never).ok).toBe(false)
    // Uppercase guesses are normalized, so 'A' counts as 'a'.
    expect(hangman.validate(s, GUESSER, { letter: 'A' }).ok).toBe(true)
  })
})
