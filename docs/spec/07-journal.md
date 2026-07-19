# 07 — Journal (JRNL), Checklist (LIST), Summaries (SUM)

## Journal

The journal is the central feed. It is a **read model** over the event stream — journal-worthy
event types rendered chronologically. There is no separate journal table.

Journal-worthy events: `journal.post`, `location.stop.ended` (journal_worthy only),
`location.crossing.state`, `trip.leg.arrived`, `game.finished`, and the trip lifecycle pair
`trip.started` / `trip.ended` (TRIP-009). The feed is scoped per trip (TRIP-007): default
scope is the active trip, else the most recently ended one, else the whole stream when no
trips exist.

Every journal entry carries a **deep link** descriptor so clients can navigate to the source:

| Entry type | `link` |
|-----------|--------|
| `game.finished` | `{kind:"game_replay", game_id}` |
| `location.stop.ended` | `{kind:"map_pin", lat, lon}` |
| `location.crossing.state` | `{kind:"checklist", state_code}` |
| `trip.leg.arrived` | `{kind:"leg_summary", destination_id}` |
| `trip.started` / `trip.ended` | `{kind:"trip_summary", trip_id}` |
| `journal.post` | none |

## Requirements — journal

| ID | Requirement | Verify |
|----|-------------|--------|
| JRNL-001 | `GET /api/journal` returns exactly the journal-worthy events, newest-first, with cursor pagination (`before`/`limit`), each rendered with type, timestamp, actor (when any), display text, and `link`. | auto |
| JRNL-002 | Journal ordering uses `client_ts`, so posts queued offline appear at the time they were written, not the time they synced. | auto |
| JRNL-003 | `POST /api/journal` creates a `journal.post` (1–2000 chars, non-blank) from any profile and it is immediately visible in the feed (no moderation). | auto |
| JRNL-004 | Non-journal-worthy events (pings, moves, config/admin, short stops) never appear in the feed. | auto |
| JRNL-005 | Each entry type carries the deep-link descriptor from the table above. | auto |
| JRNL-006 | Game-result entries render as "<winner> beat <loser> in <game>, <n> moves" (or a draw phrasing) — data comes from the `game.finished` payload only. | auto |

## Checklist

| ID | Requirement | Verify |
|----|-------------|--------|
| LIST-001 | `GET /api/checklist` returns states driven through (with first-entered timestamp), cities passed, and journal-worthy stops, all derived from crossing/stop events. | auto |
| LIST-002 | States appear once each regardless of re-entry count; `first_entered_at` is the first crossing's timestamp. | auto |

## Summaries

| ID | Requirement | Verify |
|----|-------------|--------|
| SUM-001 | `GET /api/legs` lists completed legs with their `trip.leg.arrived` summaries; `GET /api/legs/{destination_id}` returns one. | auto |
| SUM-002 | `GET /api/trip/summary` aggregates the trip in scope from events (default scope per TRIP-007; the whole stream when no trips exist): total miles, wall/moving hours, states count, journal-worthy stops, and games played. No per-person breakdowns (no per-profile wins or journal-post counts) are computed or emitted. | auto |
| SUM-003 | Trip summary equals the sum of its parts: totals match the per-leg summaries plus the in-progress leg (verified against a simulated multi-leg trip). | auto |
