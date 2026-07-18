import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { z } from 'zod'
import type { BaseState, GameEngine, ProfileId } from '../types.js'

/**
 * Hangman (GAME-013/014): asymmetric — the creator (players[0]) sets the word at
 * creation, the joiner (players[1]) guesses letters. Six wrong guesses win for the
 * setter; revealing every letter wins for the guesser. The setter never takes a
 * turn: `turn` is the guesser for the whole game.
 *
 * Word rules (validated at CREATE time, GAME-013):
 *  - letters A–Z and spaces only; case-insensitive; whitespace collapsed
 *  - per-word cap of 15 letters, always
 *  - phrases: max 3 words / 30 letters total, with visible word boundaries
 *  - single words are checked against data/words.txt unless ignore_dictionary —
 *    phrases always skip the dictionary (multi-word entries are names/places/inside
 *    jokes by nature, i.e. phrases carry ignore_dictionary semantics implicitly).
 */

export interface HangmanMove {
  letter: string
}

export interface HangmanState extends BaseState {
  /** Normalized lowercase word/phrase (single spaces). Never exposed in guesser/spectator views while ongoing (GAME-014). */
  word: string
  /** Lowercase letters in guess order. */
  guessed: string[]
  wrong: number
}

export const MAX_WRONG = 6
const MAX_WORD_LETTERS = 15
const MAX_PHRASE_WORDS = 3
const MAX_PHRASE_LETTERS = 30

const optionsSchema = z.object({
  word: z.string(),
  ignore_dictionary: z.boolean().optional(),
})

const moveSchema = z.object({ letter: z.string().regex(/^[a-zA-Z]$/) })

let dictionary: Set<string> | null = null

/** data/words.txt, loaded once as a lowercase set. */
function loadDictionary(): Set<string> {
  if (!dictionary) {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'words.txt')
    dictionary = new Set(
      readFileSync(file, 'utf8')
        .split('\n')
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean),
    )
  }
  return dictionary
}

/** Lowercase, trim, collapse runs of whitespace to single spaces. */
function normalizeWord(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Create-time validation of hangman options (GAME-013). Returns the normalized word
 * on success so init/replay share one canonical form.
 */
export function validateHangmanOptions(options: unknown): { ok: true; word: string } | { ok: false; reason: string } {
  const parsed = optionsSchema.safeParse(options)
  if (!parsed.success) return { ok: false, reason: 'hangman needs options { word: string, ignore_dictionary?: boolean }' }
  const word = normalizeWord(parsed.data.word)
  if (word.length === 0) return { ok: false, reason: 'the word must not be empty' }
  if (!/^[a-z ]+$/.test(word)) return { ok: false, reason: 'only the letters A-Z and spaces are allowed' }
  const words = word.split(' ')
  if (words.length > MAX_PHRASE_WORDS) return { ok: false, reason: `phrases are capped at ${MAX_PHRASE_WORDS} words` }
  if (words.some((w) => w.length > MAX_WORD_LETTERS)) {
    return { ok: false, reason: `each word is capped at ${MAX_WORD_LETTERS} letters` }
  }
  const letterCount = word.replace(/ /g, '').length
  if (letterCount > MAX_PHRASE_LETTERS) return { ok: false, reason: `phrases are capped at ${MAX_PHRASE_LETTERS} letters` }
  // Dictionary check: single words only — phrases imply ignore_dictionary semantics.
  if (words.length === 1 && !parsed.data.ignore_dictionary && !loadDictionary().has(word)) {
    return { ok: false, reason: 'word not found in the dictionary — set ignore_dictionary for names or inside jokes' }
  }
  return { ok: true, word }
}

function revealed(state: HangmanState): boolean {
  return [...state.word].every((ch) => ch === ' ' || state.guessed.includes(ch))
}

export const hangman: GameEngine<HangmanState, HangmanMove> = {
  init(options, players) {
    const checked = validateHangmanOptions(options)
    // The service validates at create time (GAME-013); a failure here means a corrupt
    // game.created event and must not fold silently.
    if (!checked.ok) throw new Error(`invalid hangman options: ${checked.reason}`)
    return { players, turn: players[1], word: checked.word, guessed: [], wrong: 0 }
  },

  validate(state, by, move) {
    if (hangman.status(state).phase !== 'ongoing') return { ok: false, reason: 'the game is already over' }
    if (by === state.players[0]) return { ok: false, reason: 'the word setter does not take turns' }
    if (by !== state.players[1]) return { ok: false, reason: 'not a player in this game' }
    const parsed = moveSchema.safeParse(move)
    if (!parsed.success) return { ok: false, reason: 'move must be { letter: "a".."z" }' }
    if (state.guessed.includes(parsed.data.letter.toLowerCase())) {
      return { ok: false, reason: `letter "${parsed.data.letter.toLowerCase()}" was already guessed` }
    }
    return { ok: true }
  },

  apply(state, _by, move) {
    const letter = moveSchema.parse(move).letter.toLowerCase()
    return {
      players: state.players,
      turn: state.players[1], // always the guesser (the setter never moves)
      word: state.word,
      guessed: [...state.guessed, letter],
      wrong: state.word.includes(letter) ? state.wrong : state.wrong + 1,
    }
  },

  status(state) {
    if (state.wrong >= MAX_WRONG) return { phase: 'won', winner: state.players[0] }
    if (revealed(state)) return { phase: 'won', winner: state.players[1] }
    return { phase: 'ongoing' }
  },

  view(state, viewer?: ProfileId) {
    const finished = hangman.status(state).phase !== 'ongoing'
    // GAME-014: unguessed letters are masked, spaces stay visible; the word itself is
    // only present for the setter — or for everyone once the game is over.
    const display = [...state.word]
      .map((ch) => (ch === ' ' ? ' ' : state.guessed.includes(ch) ? ch : '_'))
      .join('')
    return {
      display,
      guessed: state.guessed,
      wrong: state.wrong,
      max_wrong: MAX_WRONG,
      turn: state.turn,
      players: { setter: state.players[0], guesser: state.players[1] },
      ...(viewer === state.players[0] || finished ? { word: state.word } : {}),
    }
  },
}
