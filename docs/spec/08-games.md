# 08 — Games (GAME)

Turn-based only (product decision). Six games: **chess, checkers, tic-tac-toe, ultimate
tic-tac-toe, hangman, Four in a Row** (wire value `fourinarow`). All games are **event-sourced**: every move is a `game.move` event, and
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

The grid games use **three deliberately distinct move shapes**, one per kind of move:

| Game(s) | Move shape | Why |
|---------|-----------|-----|
| chess, checkers | `{ from, to }` (algebraic squares, below) | a piece travels from an origin square to a destination |
| tic-tac-toe | `{ cell: 0..8 }` (ultimate adds `board: 0..8`) | a mark is placed on any empty cell; there is no origin |
| Four in a Row | `{ column: 0..6 }` | a disc is dropped into a column; the landing row is **derived by gravity**, so the column alone is the whole move |

The two piece-moving grid games — **chess and checkers** — use the **same algebraic square notation** so a
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
- Four in a Row (`fourinarow`): 7 columns × 6 rows; the creator (`players[0]`) moves first.
  A move is `{ column: 0..6 }` and the disc lands in the **lowest empty row** of that column.
  Four of one player's discs in a line — horizontal, vertical, or either diagonal — wins; all
  42 cells filled with no line is a draw. A full column, a column outside `0..6`, a malformed
  payload, a move out of turn, or any move once the game is over is rejected. Nothing is
  hidden, so the view is viewerless. Resigning follows the symmetric rule (GAME-015).
- Ultimate tic-tac-toe: 9 sub-boards; a move dictates the opponent's next sub-board; won
  sub-boards form the macro board; a full sub-board without a winner counts for neither side;
  if the dictated sub-board is decided/full, the player may choose any open sub-board.
- Hangman: asymmetric — the **creator sets the word/phrase** at creation; the joiner guesses
  letters; 6 wrong guesses lose (win for setter), completing the phrase wins for the guesser.
  The setter never takes a turn.

### Hangman end-game / resignation asymmetry (GAME-018)

Consistent with "the setter never takes a turn", ending a hangman game is also asymmetric, and
deliberately differs from the symmetric-game resign rule (GAME-015):

- **The guesser (`players[1]`) cannot end the game.** A resign request from the guesser is
  rejected with **403 forbidden** ("only the word setter can end this hangman game") and the game
  stays `active`. There is no "concede" for the guesser — the only ways the guessing side ends is
  by solving the word (guesser wins) or running out of guesses (setter wins) via normal moves.
- **Only the setter/creator (`players[0]`) can end a hangman game, and doing so ABANDONS it.**
  The setter is ending their own puzzle, so nobody wins: `status = 'abandoned'`,
  `result = 'abandoned'`, `winner_id = null`, and a `game.abandoned` event is emitted (this is
  **not** a guesser win). Abandonment is not a game result, so it produces no `game_result`
  journal entry.

> Product decision (2026-07): this asymmetry is intentional (roadtrip-backend#77 /
> roadtrip-android#82). A guesser conceding would otherwise hand the setter a "win" for a puzzle
> the family never finished; instead the shared puzzle can only be torn down by the person who
> built it. Revisit here if the desired affordance changes.

### Hangman word rules (from design doc)

- Default: single word, validated against the bundled dictionary (`data/words.txt`).
- `ignore_dictionary: true` at creation skips validation (names, inside jokes, places).
- Even with dictionary off: per-word length cap of 15; phrases allowed with visible word
  boundaries (wheel-of-fortune style), max 3 words / 30 letters total; letters A–Z only.

### Four in a Row board and recorded move (GAME-020)

The board is a `[row][column]` grid of 6 rows × 7 columns with **row 0 at the bottom** (row 5
is the top), so a disc's row index equals the number of discs already in its column when it
was dropped. Each cell is `0` (a `players[0]` disc), `1` (a `players[1]` disc) or `null`.

The engine `view` (same for every viewer) is:

```jsonc
{
  "board": [[0, 1, null, null, null, null, null], …],  // 6 rows × 7 columns, row 0 = bottom
  "discs": ["<players[0] profile id>", "<players[1] profile id>"],  // cell value → profile
  "turn": "<profile id of the player to move>",
  "players": ["<creator id>", "<joiner id>"]
}
```

The recorded `game.move` payload is normalized to `{ column, row }`, where `row` is the landing
row the disc came to rest in (row 0 = bottom). `row` is **advisory**, like checkers' `captured`:
re-applying a recorded move ignores it and re-derives the landing row by gravity, so the fold
stays deterministic (GAME-006).

- **Invariant:** the landing row is always derived from the column's current fill, never taken
  from the client's payload — a submitted or recorded `row` cannot place a disc.

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
| GAME-015 | For symmetric games, resigning ends the game as a win for the opponent (`game.finished`, result "win", journal entry says "resigned"). Hangman is asymmetric and follows GAME-018 instead. | auto |
| GAME-016 | A challenge creates a notification-feed item for the invited profile (see NOTIF-002). | auto |
| GAME-017 | Tic-tac-toe detects wins on rows/columns/diagonals and draws on a full board. | auto |
| GAME-018 | Hangman resignation is asymmetric (see below): the guesser cannot end the game — a resign from the guesser gets 403 and leaves the game active; only the setter/creator can end a hangman game, which **abandons** it (`status`/`result` = "abandoned", `winner_id` null, `game.abandoned` emitted) rather than producing a winner. | auto |
| GAME-019 | Every `Game` serialization for a hangman game with folded state (active or finished) carries a top-level `hangman_display` string — the masked board (guessed letters revealed, unguessed as `_`, spaces preserved) — on **both** the list/lobby summary (`GET /api/games`, no engine `view`) and `GET /api/games/{id}`, so the lobby can show progress without a per-game view fetch. It reuses the exact `view.display` masking and is **viewerless**: for an ongoing game it NEVER contains an unguessed letter (not even for the setter); once finished it may show the fully revealed word. It is omitted/absent for non-hangman games and for open hangman games that have no state yet. | auto |
| GAME-020 | Four in a Row (`fourinarow`) plays on a 7×6 board: the creator moves first; a `{ column: 0..6 }` move drops a disc into the lowest empty row of that column; four in a line horizontally, vertically or on either diagonal wins for that player, and a full board with no line is a draw; a full column, an out-of-range column, a malformed payload, an out-of-turn move and a move after the game is over are rejected. The view is viewerless (`board` 6×7 with row 0 = bottom, `discs`, `turn`, `players`) and the recorded `game.move` is normalized to `{ column, row }` with an advisory landing `row`. | auto |
