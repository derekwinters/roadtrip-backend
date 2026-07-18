/**
 * Game engine contract (docs/spec/08-games.md, "Engine contract").
 *
 * Engines are pure: server-side state is a fold of the game's event stream (GAME-006).
 * `init` runs when the game activates (game.joined) — the creator is players[0], the
 * joiner players[1] — and `apply` folds each game.move event. No engine method may
 * mutate its input state, touch the clock, or read anything outside its arguments.
 */

export type ProfileId = string

export interface GameEngine<S, M> {
  init(options: unknown, players: [ProfileId, ProfileId]): S
  validate(state: S, by: ProfileId, move: M): { ok: true } | { ok: false; reason: string }
  apply(state: S, by: ProfileId, move: M): S
  status(state: S): { phase: 'ongoing' } | { phase: 'draw' } | { phase: 'won'; winner: ProfileId }
  view(state: S, viewer?: ProfileId): unknown // hides hangman's word from the guesser
}

/**
 * Every engine state carries the two players and whose turn it is. `turn` always names
 * the player who would move next (even in terminal positions — `status` is the
 * authority on whether the game is over; the service exposes turn=null once finished).
 */
export interface BaseState {
  players: [ProfileId, ProfileId]
  turn: ProfileId
}
