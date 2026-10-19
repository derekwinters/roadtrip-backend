-- Dots and Boxes as a seventh game type (docs/spec/08-games.md, GAME-023).
-- Migrations are additive: widen games_game_type_check here (as 006 did) rather than
-- editing 001_init.sql or 006_four_in_a_row.sql.

ALTER TABLE games DROP CONSTRAINT games_game_type_check;
ALTER TABLE games ADD CONSTRAINT games_game_type_check
  CHECK (game_type IN ('chess','checkers','tictactoe','ultimate','hangman','fourinarow','dotsandboxes'));
