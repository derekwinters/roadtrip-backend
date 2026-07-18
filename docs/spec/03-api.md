# 03 — API Conventions

The normative HTTP contract is `docs/spec/openapi.yaml`. This file fixes the conventions the
contract follows.

## Conventions

- Base path `/api`; JSON everywhere; UTC ISO-8601 timestamps.
- Identity: `X-Profile-Id: <uuid>` header (see 04). `GET /api/profiles` and `GET /api/health`
  are the only unauthenticated routes (plus `POST /api/profiles` only while zero profiles
  exist — the first-run bootstrap, PRO-008).
- Errors: `{ "error": { "code": string, "message": string } }` with proper status codes.
  Stable machine codes: `unauthenticated`, `parent_required`, `not_found`, `validation`,
  `not_your_turn`, `illegal_move`, `game_full`, `not_invited`, `conflict`,
  `geocode_unavailable`.
- Cursors: event feeds use the event `seq` as an exclusive `after` cursor; the journal uses
  `before` for backward pagination. Long-poll via `wait=<1..30>` seconds.
- Idempotency: client-generated UUID `event_id` on every synced event (EVT-001).

## Endpoint inventory

| Method & path | Purpose | Auth |
|---------------|---------|------|
| GET `/api/health` | liveness/connectivity probe | none |
| GET `/api/profiles` | login screen list | none |
| POST `/api/profiles` | create profile | parent (none while zero profiles exist, PRO-008) |
| PATCH `/api/profiles/{id}` | update profile | parent |
| GET `/api/config` / PUT `/api/config` | read / update tunables | any / parent |
| GET `/api/destinations` | ordered destination list | any |
| POST `/api/destinations` | add destination | parent |
| PATCH `/api/destinations/{id}` | edit destination | parent |
| DELETE `/api/destinations/{id}` | remove pending destination | parent |
| POST `/api/sync/batch` | offline event upload | any (per-event rules) |
| GET `/api/events` | cursor feed of events (long-poll) | any |
| GET `/api/journal` / POST `/api/journal` | feed / manual post | any |
| GET `/api/map` | map/progress state | any |
| GET `/api/checklist` | states/cities/stops | any |
| GET `/api/legs` / GET `/api/legs/{destinationId}` | leg summaries | any |
| GET `/api/trip/summary` | aggregation for the trip in scope | any |
| GET `/api/trips` | list trips | any |
| POST `/api/trips` | start a trip | parent |
| PATCH `/api/trips/{id}` | rename a trip | parent |
| POST `/api/trips/{id}/end` | end the active trip | parent |
| GET `/api/trips/{id}/summary` | one trip's aggregation | any |
| GET `/api/games` | lobby & game lists (`status` filter) | any |
| POST `/api/games` | create game (open/challenge) | any |
| POST `/api/games/{id}/join` | join | any (invite rules) |
| POST `/api/games/{id}/moves` | make a move | players only |
| POST `/api/games/{id}/resign` | resign | players only |
| GET `/api/games/{id}` | current state (engine view) | any |
| GET `/api/games/{id}/events` | move stream (replay/spectate, long-poll) | any |
| GET `/api/notifications` | per-profile notification feed (long-poll) | any |
| GET `/api/geocode` | address search proxy (cached, throttled, best-effort online) | parent |

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| API-001 | Error responses follow the error envelope with stable `code` values listed above. | auto |
| API-002 | Validation failures return 400 with `code="validation"` and never partially apply a write. | auto |
| API-003 | Every implemented route is documented in `openapi.yaml` and every documented route is implemented (checked by the spec validator). | auto |
| API-004 | Unknown routes under `/api` return the error envelope with 404, not Fastify's default. | auto |
