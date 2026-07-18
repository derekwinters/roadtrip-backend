# 12 — Trips (TRIP)

Multiple named road trips over the app's lifetime: a parent taps **"road trip starts now"**,
all activity from that point associates with the trip, and ending it freezes a browsable
snapshot (journal, checklist, legs, summary) so the family can reuse the app for future trips
and look back on old ones.

Starting/ending/renaming trips is **parent-only**, consistent with the permissions matrix in
`04-profiles.md`.

## Design

- New `trips` read model: `id, name, status ('active'|'ended'), started_at, ended_at`;
  at most **one active trip** at a time (enforced by a partial unique index). `trip.started` /
  `trip.ended` events are the system of record (append-only, like everything else). Renaming
  is a plain read-model update — the lifecycle events carry the name at start/end time.
- **Association rule**: every event stores a nullable `trip_id`, resolved at insert time as
  the trip whose `[started_at, ended_at)` window contains the event's `client_ts`. This means
  offline events flushed *after* a trip ended still land in the right trip — the same
  clock-of-record principle the journal already uses (JRNL-002). The `trip.ended` event is
  appended just before the window closes, so both lifecycle events belong to their own trip.
- **Engine epochs** (TRIP-006): the location engine tracks the trip containing the ping it is
  processing. When that trip changes, it starts a new epoch: leg mileage/states/start reset,
  the state annotation resets (so the starting state is checklisted per trip, GEO-003-style),
  a stop left open by the previous epoch is abandoned (its row keeps the old trip), and leg
  numbering continues from what the new scope already has — a fresh trip therefore starts at
  leg 0. Legs, stops, and cities-visited rows carry the epoch's `trip_id`; city dedupe is per
  trip.
- **Default read scope** (TRIP-007): read models scope to the active trip, falling back to
  the most recently ended trip, and behave exactly like the pre-trips app when no trips exist
  at all. Destinations scope to the active trip, else to the unassociated (NULL) pool, so the
  tracker keeps working between trips (TRIP-010) and a new trip starts with an empty list.
- Existing endpoints stay backward-compatible: with no trips defined, behavior is exactly
  today's single-implicit-trip behavior (TRIP-010 keeps unassociated activity readable).

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| TRIP-001 | `POST /api/trips` starts a trip (optional name, default "Road Trip <start date>"); parent-only; 409 `conflict` when a trip is already active. | auto |
| TRIP-002 | `POST /api/trips/{id}/end` ends the active trip (parent-only, idempotent-safe: ending a non-active trip is 409); emits `trip.started`/`trip.ended` events with the trip id and name. | auto |
| TRIP-003 | `GET /api/trips` lists trips (status, started/ended timestamps); `PATCH /api/trips/{id}` renames (parent-only). | auto |
| TRIP-004 | Every event stores `trip_id` resolved from the trip whose `[started_at, ended_at)` window contains its `client_ts` — including events synced after the trip ended; NULL when no window matches. | auto |
| TRIP-005 | Destinations belong to the trip active at their creation; a new trip starts with an empty destination list, and past trips keep theirs. | auto |
| TRIP-006 | Starting a trip resets the location engine accumulators (leg index, mileage, states, engine epoch); stops, crossings, legs, and cities-visited are recorded per trip (a city can be collected once per trip). | auto |
| TRIP-007 | Journal, checklist, legs, map, and trip-summary endpoints accept `?trip=<id>`; the default scope is the active trip, falling back to the most recently ended trip when none is active. | auto |
| TRIP-008 | `GET /api/trips/{id}/summary` aggregates that trip only; per-trip totals partition the all-time event stream (no double counting across trips). | auto |
| TRIP-009 | `trip.started` and `trip.ended` are journal-worthy ("Road trip started: <name>" / "Road trip complete — <miles> mi, <n> states"), deep-link to the trip summary, and produce `journal_activity` notifications. | auto |
| TRIP-010 | Events whose `client_ts` falls outside every trip window remain accepted, stored, and readable in unscoped views, but are excluded from every trip-scoped view. | auto |
| TRIP-011 | The simulator/seed tooling can populate multiple trips with distinct histories, and a scenario test proves per-trip isolation of journal/checklist/legs/summary. | auto |
| TRIP-012 | Pre-trip dry run includes starting and ending a real trip from a parent device. | manual |

## Interactions with existing specs (updated in the implementing change)

- `02-event-model.md`: `trip.started` / `trip.ended` in the catalog + the `trip_id` column.
- `06-location.md`: engine epoch reset (TRIP-006) refines LOC-006/LOC-009 leg numbering.
- `07-journal.md`: two new journal-worthy kinds (TRIP-009); SUM-002 is trip-scoped
  (TRIP-007/008).
- `openapi.yaml`: `/api/trips*` paths and the `trip` query parameter on read models.
