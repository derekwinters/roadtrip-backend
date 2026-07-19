# 08 — Games (GAME)

Turn-based only (product decision). Five games: **chess, checkers, tic-tac-toe, ultimate
tic-tac-toe, hangman**. All games are **event-sourced**: every move is a `game.move` event, and
the server-side engine state is a pure fold over the game's event stream. That one design gives
lobby, challenge, spectate, and replay for free.

## Lifecycle

```
POST /api/games            → status "open" (mode=open) or "open"+invite (mode=challenge)
POST /api/games/{id}/join  → status "active" (joiner is opponent; invited-only for challenges)
POST /api/games/{id}/moves → validated move, alternating turns
                           → status "finished" on win/draw (auto journal post via game.finished)
POST /api/games/{id}/resign→ status "finished", result win for the other player
```

## Engine contract

Each game type implements the pure interface:

```ts
interface GameEngine<S, M> {
  init(options: unknown, players: [ProfileId, ProfileId]): S
  validate(state: S, by: ProfileId, move: M): { ok: true } | { ok: false; reason: string }
  apply(state: S, by: ProfileId, move: M): S
  status(state: S): { phase: 'ongoing' } | { phase: 'draw' } | { phase: 'won'; winner: ProfileId }
  view(state: S, viewer?: ProfileId): unknown   // hides hangman's word from the guesser
  record?(state: S, by: ProfileId, move: M): unknown  // normalized move for the game.move event
}
```

- Chess uses **chess.js** for legality, check(mate), stalemate, and draw rules; moves are
  `{from,to,promotion?}`.
- Checkers: American rules — 8×8, dark squares, forced captures, multi-jumps, kings; draw when
  a position repeats 3× or 40 moves pass without a capture or man advance. Moves are
  `{from,to}` in the same algebraic square notation as chess (below); a jump is a single
  `game.move` and the recorded event also carries the captured square(s).

### Move coordinate representation (grid games)

Both grid games — **chess and checkers** — use the **same algebraic square notation** so a
single client move shape works for both (`{ from, to }`, each matching `^[a-h][1-8]$`). Files
`a`–`h` run left→right, ranks `1`–`8` bottom→top. Internally checkers keeps its board as a
`[row][col]` array (`row`, `col` = `0..7`); the mapping is **`file = 'a' + col`,
`rank = row + 1`** (so `[0,0] = a1`, `[7,7] = h8`). Play is on the dark squares, which on the
standard board (matching the Android client) are those where `(row + col)` is **even** — so
`a1` is dark. The creator (player 0) sets up on ranks 1–3
(`a1, c1, e1, g1 / b2, d2, f2, h2 / a3, c3, e3, g3`)
and advances toward rank 8; player 1 sets up on ranks 6–8 and advances toward rank 1; a man is
crowned on reaching the opponent's back rank (rank 8 for player 0, rank 1 for player 1).

The recorded `game.move` payload for checkers is normalized to
`{ from, to, captured? }`, where `captured` is the array of algebraic square(s) removed by the
move (present only for capturing moves; a single jump removes one square). This lets replay
clients render captures and infer crownings from the destination rank without re-deriving the
board. Re-applying a recorded move ignores `captured` (it is re-derived from the position), so
the fold stays deterministic (GAME-006).
- Tic-tac-toe: 3×3, X = creator.
- Ultimate tic-tac-toe: 9 sub-boards; a move dictates the opponent's next sub-board; won
  sub-boards form the macro board; a full sub-board without a winner counts for neither side;
  if the dictated sub-board is decided/full, the player may choose any open sub-board.
- Hangman: asymmetric — the **creator sets the word/phrase** at creation; the joiner guesses
  letters; 6 wrong guesses lose (win for setter), completing the phrase wins for the guesser.

### Hangman word rules (from design doc)

- Default: single word, validated against the bundled dictionary (`data/words.txt`).
- `ignore_dictionary: true` at creation skips validation (names, inside jokes, places).
- Even with dictionary off: per-word length cap of 15; phrases allowed with visible word
  boundaries (wheel-of-fortune style), max 3 words / 30 letters total; letters A–Z only.

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| GAME-001 | Creating a game emits `game.created`; `mode=open` games appear in the lobby (`GET /api/games?status=open`) for anyone to join; `mode=challenge` requires `invited_profile_id`. | auto |
| GAME-002 | Only the invited profile can join a challenge game; other profiles get 403. Creators cannot join their own game. | auto |
| GAME-003 | Joining emits `game.joined` and activates the game; a third join attempt gets 409. | auto |
| GAME-004 | Moves are validated by the game engine; illegal moves get 400 with the engine's reason, and no event is persisted. | auto |
| GAME-005 | Moves out of turn (including moves on non-active games or by non-players) are rejected with 409/403 and no event. | auto |
| GAME-006 | Server-side state is a pure fold: replaying a finished game's events from scratch reproduces the final state exactly (replay determinism, per game type). | auto |
| GAME-007 | Win/draw detection ends the game, emits `game.finished` with result, winner/loser, and move count, and the result appears as a journal entry deep-linking to the replay. | auto |
| GAME-008 | `GET /api/games/{id}` returns current state via the engine `view` (turn, board/display state, players, status); `GET /api/games/{id}/events` returns the ordered move stream for replay with play/pause/step performed client-side. | auto |
| GAME-009 | Spectating = polling `GET /api/games/{id}/events?after=<seq>&wait=<s>`: a third client long-polling the stream observes every move of a live game in order. | auto |
| GAME-010 | Chess legality, check/checkmate/stalemate and draw detection come from chess.js; the engine never accepts a move chess.js rejects. | auto |
| GAME-011 | Checkers enforces forced captures and multi-jump continuation; kings move/capture backwards. Moves use algebraic `{from,to}` squares (as chess), converted to the internal `[row][col]` board (`file='a'+col`, `rank=row+1`); the recorded `game.move` is normalized to `{from,to,captured?}` with the captured algebraic square(s), and crowning happens at the opponent's back rank. | auto |
| GAME-012 | Ultimate tic-tac-toe enforces the dictated-sub-board rule including the free-choice case for decided/full boards. | auto |
| GAME-013 | Hangman validates the word against the dictionary by default; `ignore_dictionary` skips it; length/word-count caps are always enforced (GAME word rules above). | auto |
| GAME-014 | Hangman phrases display word boundaries: unguessed letters are masked but spaces are visible in the guesser's view; the setter's word is never present in the guesser/spectator view payload while ongoing, and the event feeds redact the word from `game.created` payloads until the game finishes. | auto |
| GAME-015 | Resigning ends the game as a win for the opponent (`game.finished`, result "win", journal entry says "resigned"). | auto |
| GAME-016 | A challenge creates a notification-feed item for the invited profile (see NOTIF-002). | auto |
| GAME-017 | Tic-tac-toe detects wins on rows/columns/diagonals and draws on a full board. | auto |
