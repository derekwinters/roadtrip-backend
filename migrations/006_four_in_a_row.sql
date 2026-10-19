-- Four in a Row as a sixth game type (docs/spec/08-games.md, GAME-020).
-- The game_type CHECK is inline in 001_init.sql, so Postgres named it games_game_type_check.
-- Migrations are additive: widen the constraint here rather than editing 001_init.sql.

ALTER TABLE games DROP CONSTRAINT games_game_type_check;
ALTER TABLE games ADD CONSTRAINT games_game_type_check
  CHECK (game_type IN ('chess','checkers','tictactoe','ultimate','hangman','fourinarow'));
