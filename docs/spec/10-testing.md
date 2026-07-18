# 10 — Testing Strategy & Simulation (SIM)

The event-sourced design makes the whole system testable by **injecting synthetic events**.
Testing is not an afterthought: every `auto` requirement in these specs must be referenced by
at least one test (enforced by `npm run validate:specs`, which fails CI otherwise).

## Test layers

1. **Unit** (`test/unit/`) — pure logic: geometry/haversine, stop detection state machine,
   game engines (move legality, win/draw, replay determinism), geocoding lookups, notification
   derivation. No database.
2. **Integration** (`test/integration/`) — the real Fastify app against a real PostgreSQL
   (docker-compose service / `scripts/test-db.sh`; CI uses a service container). Drives the
   public HTTP API only.
3. **Scenario** (`test/scenario/`) — end-to-end trips via the **GPS trip simulator** feeding
   the real API: multi-leg drives, offline flushes, mixed devices, full-family game days.
4. **Contract** — every implemented route exists in `docs/spec/openapi.yaml` with matching
   methods; validated by the spec validator.
5. **Dry run** (manual, pre-trip) — real 30–60 min drive with one stop, phone pinging the home
   server through hotspot+VPN, tablets connected, one game played en route.

## GPS trip simulator

`npm run simulate` — also exposed as a library for scenario tests.

- Input: ordered waypoints (or GeoJSON LineString) + average speeds per segment.
- Emits `location.ping` events at the configured cadence with **time compression** (simulate a
  12-hour drive in seconds by scaling timestamps; the server never sleeps on client_ts).
- Scenario library (each is a named preset): `normal_drive`, `gas_stop` (15 min),
  `lunch_stop` (45 min), `traffic_jam` (slow pings in place), `gps_jitter` (±50 m noise),
  `state_crossing`, `arrival`, `multi_leg_day`.

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| SIM-001 | The simulator emits pings along the waypoint path at the configured interval and speed, with timestamps compressed by the given factor. | auto |
| SIM-002 | The `gas_stop` scenario (15 min stationary) produces exactly one journal-worthy stop with backdated start and correct duration when run through the API. | auto |
| SIM-003 | The `gps_jitter` scenario keeps a 15-minute stop detected as one stop despite ±50 m noise (validates LOC-011 end-to-end). | auto |
| SIM-004 | The `state_crossing` scenario produces the expected `location.crossing.state` sequence and checklist entries. | auto |
| SIM-005 | The `arrival` scenario triggers arrival detection and a leg summary whose miles/wall/moving/stops figures match the scenario's reference values. | auto |
| SIM-006 | The `traffic_jam` scenario registers a stop (accepted quirk, documented in 06) — the assertion pins the documented behavior. | auto |
| SIM-007 | `npm run seed:demo` populates a fabricated full day — pings, stops, crossings, several finished games, manual posts, a leg summary, a partially filled bingo card (BNG-006) — leaving every read endpoint non-empty (used for UI development). | auto |
| SIM-008 | A scripted multi-client game test: two clients play a full chess game through the API while a third long-polls the spectate stream and observes every move in order (validates GAME-009 at scenario level). | auto |

## Documentation validation (`npm run validate:specs`)

Checks, failing CI on violation:
1. Requirement IDs are unique across all spec files.
2. Every `auto` requirement is referenced by ≥1 test file (`[ID]` in a test name or `covers:` comment).
3. Relative links in `docs/**` resolve to existing files.
4. `openapi.yaml` parses, and every Fastify route (method+path) appears in it and vice versa.
