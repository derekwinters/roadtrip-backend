# 02 — Event Model

## The `events` table

| Column | Type | Notes |
|--------|------|-------|
| `seq` | BIGSERIAL PK | Server-assigned total order; the sync cursor. |
| `event_id` | UUID UNIQUE | Client-generated for client events, server-generated for derived events. Idempotency key. |
| `type` | TEXT | One of the catalog below. |
| `actor_id` | UUID NULL | Profile that caused the event; NULL for server-derived events. |
| `device_id` | TEXT NULL | Originating device identifier for client events. |
| `payload` | JSONB | Type-specific body (schemas below are normative). |
| `client_ts` | TIMESTAMPTZ | When it happened (client clock; backdated for derived stops). |
| `server_ts` | TIMESTAMPTZ | When the server persisted it. |

## Event type catalog

Client-originated (accepted via sync batch or dedicated endpoints):

| Type | Payload | Produced by |
|------|---------|-------------|
| `location.ping` | `{lat, lon, accuracy_m?, speed_mps?}` | parent phone only |
| `journal.post` | `{text}` (1–2000 chars) | any profile |

Server-derived (never accepted from clients):

| Type | Payload |
|------|---------|
| `location.stop.started` | `{stop_id, lat, lon}` — `client_ts` backdated to first stationary ping |
| `location.stop.ended` | `{stop_id, lat, lon, started_at, ended_at, duration_min, place?}` |
| `location.crossing.state` | `{state, state_code, prev_state_code?}` |
| `location.crossing.city` | `{city, state_code}` |
| `trip.leg.arrived` | `{destination_id, destination_name, summary: LegSummary}` |
| `game.created` | `{game_id, game_type, mode: "open"\|"challenge", invited_profile_id?, options}` |
| `game.joined` | `{game_id, profile_id}` |
| `game.move` | `{game_id, move_no, move}` (move shape is game-specific, see 08) |
| `game.finished` | `{game_id, result: "win"\|"draw", winner_profile_id?, loser_profile_id?, move_count}` |
| `game.abandoned` | `{game_id, by_profile_id}` |
| `destination.added` / `destination.updated` / `destination.removed` | `{destination_id, name?, lat?, lon?, order_index?}` |
| `config.updated` | `{changes: {key: value}}` |
| `profile.created` / `profile.updated` | `{profile_id, name, avatar, role}` |

Game events are recorded by the game endpoints (online-only actions); `location.*`,
`trip.*` are emitted by the location engine while processing pings.

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| EVT-001 | Inserting an event with an `event_id` that already exists is a no-op reported as `duplicate`; the stored event is unchanged (idempotent sync retries). | auto |
| EVT-002 | `seq` is strictly increasing and unique across all events; clients can use `after=seq` as an exclusive cursor and never miss or double-receive an event. | auto |
| EVT-003 | Every event type in this catalog has a Zod payload schema; events with malformed payloads are rejected with a 400 and are not persisted. | auto |
| EVT-004 | Client-originated types are limited to `location.ping` and `journal.post` via sync; attempts to sync server-derived types are rejected per-event as `rejected` with reason `forbidden_type`. | auto |
| EVT-005 | `location.ping` events are only accepted from profiles with the parent role; kid profiles get per-event `rejected` with reason `not_parent`. | auto |
| EVT-006 | Events preserve `client_ts` as supplied and record independent `server_ts`; journal ordering uses `client_ts` (see JRNL-002). | auto |
| EVT-007 | `GET /api/events?after=<seq>&limit=<n>&types=<csv>` returns events in `seq` order, filtered by type when given, with `next_after` cursor. | auto |
| EVT-008 | An events request with `wait=<seconds>` (1–30) long-polls: it returns immediately if matching events exist after the cursor, otherwise holds the request until one arrives or the wait elapses (then returns an empty page). | auto |
