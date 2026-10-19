# 05 — Runtime Configuration

All detection thresholds are **runtime-tunable** and **parent-configurable** (resolved design
decision). Nothing in the location engine hardcodes them. The same mechanism lets tests and the
simulator tighten intervals. The config table also carries behavior flags (booleans) under the
same seeding, reading, and parent-only-write rules.

## Keys, defaults, bounds

| Key | Default | Bounds | Meaning |
|-----|---------|--------|---------|
| `ping_interval_s` | 300 | 5–3600 | Expected cadence of parent-phone pings (client reads this). |
| `stop_radius_m` | 100 | 20–1000 | Two consecutive pings within this distance ⇒ stationary. |
| `min_stop_duration_min` | 10 | 1–240 | Stops at least this long are journal-worthy and counted in summaries. |
| `arrival_radius_m` | 800 | 100–5000 | Stop within this distance of the active destination ⇒ arrival (~0.5 mi default). |
| `city_radius_km` | 15 | 1–50 | Ping within this distance of a city centroid ⇒ city visited, among cities at or above `city_min_population` (GEO-004, GEO-009). |
| `city_min_population` | 5000 | 0–10000000 (integer) | Smallest place population that counts as a city for GEO-004/GEO-006/GEO-008; smaller bundled places are ignored at lookup time (GEO-009). |
| `track_cities_through` | true | boolean | While true, cities the vehicle travels through are recorded as visited (GEO-004, GEO-007). |
| `track_cities_stopped` | true | boolean | While true, the city of a journal-worthy stop is also recorded as visited (GEO-008). The stop's `place` label (GEO-006) is applied either way. |
| `stop_label_max_chars` | 80 | 1–2000 (integer) | Longest user-supplied stop label accepted after trimming (LOC-015); longer labels are rejected, never truncated. |
| `operational_log_max_rows` | 1000 | 1–100000 (integer) | Maximum number of rows kept in the operational log; the oldest are removed beyond it (see `15-operational-log.md`). |
| `open_profile_creation` | true | boolean | While true, `POST /api/profiles` is open to everyone — unauthenticated and kid profiles included (PRO-009). Parents can turn it off to restore parent-only creation. |
| `game_chess_enabled` | true | boolean | While false, new chess games cannot be created family-wide (GAME-021); games already started are unaffected (GAME-022). |
| `game_checkers_enabled` | true | boolean | Same, for checkers. |
| `game_tictactoe_enabled` | true | boolean | Same, for tic-tac-toe. |
| `game_ultimate_enabled` | true | boolean | Same, for ultimate tic-tac-toe. |
| `game_hangman_enabled` | true | boolean | Same, for hangman. |
| `game_fourinarow_enabled` | true | boolean | Same, for Four in a Row. |
| `game_dotsandboxes_enabled` | true | boolean | Same, for Dots and Boxes. |

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| CFG-001 | `GET /api/config` returns all keys with current values; readable by any profile. | auto |
| CFG-002 | `PUT /api/config` accepts a partial object of known keys, is parent-only, and rejects unknown keys (400) and out-of-bounds values (400) without applying any part of the batch. | auto |
| CFG-003 | Config changes emit a `config.updated` event containing exactly the changed keys and take effect for the next processed ping without a server restart. | auto |
| CFG-004 | The location engine reads every threshold from config: changing `stop_radius_m`, `min_stop_duration_min`, or `arrival_radius_m` observably changes detection behavior in tests. | auto |
| CFG-005 | Defaults above are seeded on first startup; missing keys self-heal to defaults on boot. | auto |
| CFG-006 | `open_profile_creation` is a boolean key defaulting to `true`, seeded/self-healed like every key (CFG-005) and togglable only by parents via `PUT /api/config`; non-boolean values are rejected 400 `validation` under the CFG-002 all-or-nothing rule. | auto |
| CFG-007 | `operational_log_max_rows` is an integer key defaulting to `1000` (bounds 1–100000), seeded/self-healed like every key (CFG-005) and changeable only by parents via `PUT /api/config`; non-integer or out-of-bounds values are rejected 400 `validation` under the CFG-002 all-or-nothing rule. The operational log reads it at record time (OPLOG-004). | auto |
| CFG-008 | `stop_label_max_chars` is an integer key defaulting to `80` (bounds 1–2000), seeded/self-healed like every key (CFG-005) and changeable only by parents via `PUT /api/config`; non-integer or out-of-bounds values are rejected 400 `validation` under the CFG-002 all-or-nothing rule. Sync reads it per batch when validating `location.stop.labeled` (LOC-015), so a change applies to the next batch without a restart. | auto |
| CFG-009 | `city_min_population` is an integer key defaulting to `5000` (bounds 0–10000000), and `track_cities_through` / `track_cities_stopped` are boolean keys defaulting to `true`; `city_radius_km` defaults to `15`. All are seeded/self-healed like every key (CFG-005) and changeable only by parents via `PUT /api/config`; non-integer, non-boolean, or out-of-bounds values are rejected 400 `validation` under the CFG-002 all-or-nothing rule. The engine reads them per batch (CFG-004), so a change applies to pings processed after it and never re-evaluates pings already processed (LOC-001). | auto |
| CFG-010 | Each game type in the GAME catalog (`08-games.md`) has a boolean key `game_<type>_enabled` (`game_chess_enabled`, `game_checkers_enabled`, `game_tictactoe_enabled`, `game_ultimate_enabled`, `game_hangman_enabled`, `game_fourinarow_enabled`, `game_dotsandboxes_enabled`) defaulting to `true`, seeded/self-healed like every key (CFG-005), readable by any profile (CFG-001) and togglable only by parents via `PUT /api/config`; non-boolean values are rejected 400 `validation` under the CFG-002 all-or-nothing rule, and a change emits `config.updated` with exactly the changed keys and applies to the next game creation without a restart (CFG-003). Game creation enforces them (GAME-021). | auto |

- **Invariant (CFG-010):** the game-type keys are derived from the game type catalog — every
  game type has exactly one `game_<type>_enabled` key and there is no such key for a type that
  does not exist. Adding a game type adds its key; it is never a separately maintained list.
- The game-type keys are family-wide: they gate every profile alike, parents included.
