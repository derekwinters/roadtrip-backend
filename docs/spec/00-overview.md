# Family Road Trip App — Specification Overview

This directory is the **system of record** for the Family Road Trip project. Code that
contradicts these documents is a bug in one or the other, and the discrepancy must be resolved
in the same change. See `.claude/agents/roadtrip-dev.md` for the mandatory workflow.

## Product summary

A family vacation app for two parents and two kids (each with a tablet; parents also have
phones), used during a multi-day road trip. The app centers on a shared **travel journal**
automatically populated by trip events (location pings, stops, state/city crossings, games,
leg arrivals) plus manual posts from any family member. Supporting features: live map/progress
tracking, turn-based multiplayer games, a state/city checklist, and leg/trip summaries.

Connectivity is in-car WiFi hotspot + VPN to a home server. The system must be
**offline-tolerant**: clients queue events locally with client timestamps and sync when
connectivity returns.

## Components

| Component | Repo | Tech |
|-----------|------|------|
| API server | `roadtrip-backend` | Node 22, TypeScript, Fastify, event-sourced core |
| Database | `roadtrip-backend` (compose) | PostgreSQL 16 container |
| Client app | `roadtrip-android` | Kotlin, Jetpack Compose, phones + tablets from one APK |

## Resolved design decisions

These were open items in the original design; they are now decided:

1. **Kids' map scope** — kids see the trip **start point, current position, and the next
   destination** on the map (not the full future route). Parents see the full destination list.
2. **Detection radii are parent-configurable** — stop radius, minimum stop duration, arrival
   radius, and ping interval are runtime config, editable only by parents (see `05-config.md`).
3. **Reverse geocoding is resolved server-side** — the server bundles offline datasets (US state
   polygons + city list) and annotates pings itself; clients never geocode (see `06-location.md`).
4. **Tablet notifications** — local notifications fire for **both** "challenge received" and
   "journal activity", on tablets and phones alike (see `09-sync-notifications.md`).

## Explicitly out of scope

- Real-time games (turn-based only; ~1s VPN latency tolerated)
- Photo capture/attachments
- Milestone notifications ("halfway there")
- Messaging/chat (the journal fills this role)
- Passwords or auth beyond profile selection
- Publishing to app stores (releases are GitHub release assets only)

## Requirement IDs

Every observable behavior is a row in a requirement table:

`| AREA-NNN | <requirement> | auto |` or `| AREA-NNN | <requirement> | manual |`

- `auto` — must be covered by at least one automated test that references the ID (in the test
  name or a `covers:` comment). Enforced by `npm run validate:specs` in CI.
- `manual` — verified by inspection, the pre-trip dry run, or CI mechanics that cannot
  self-test (e.g. release workflows).

- `planned` — specified and issue-tracked but not yet implemented; the validator checks ID
  uniqueness only. Flip to `auto` in the implementing change.

Backend areas: **SYS** (architecture), **EVT** (event model), **API** (API conventions),
**PRO** (profiles), **CFG** (config), **SYNC** (offline sync), **LOC** (location pipeline),
**GEO** (geocoding), **JRNL** (journal), **LIST** (checklist), **SUM** (summaries),
**GAME** (games), **NOTIF** (notifications), **SIM** (simulator + seed), **REL** (release
engineering), **TRIP** (multiple road trips).

Android areas are specified in `roadtrip-android/docs/spec/` and prefixed `AND*`.

## Spec index

| File | Contents |
|------|----------|
| `01-architecture.md` | System architecture, deployment, event-sourcing rules |
| `02-event-model.md` | The `events` table, event type catalog, idempotency |
| `03-api.md` + `openapi.yaml` | API conventions and the HTTP contract |
| `04-profiles.md` | Profiles, parent/kid roles, permissions |
| `05-config.md` | Tunable parameters and parent-only administration |
| `06-location.md` | Pings, stop/arrival detection, geocoding, mileage, legs |
| `07-journal.md` | Journal feed, checklist, leg/trip summaries, deep links |
| `08-games.md` | Game framework, five games, lobby/challenge/spectate/replay |
| `09-sync-notifications.md` | Offline sync contract, update feeds, notification events |
| `10-testing.md` | Test strategy, GPS trip simulator, seed data, validation tooling |
| `11-release-engineering.md` | Versioning (release-please), CI artifacts, RC + final releases |
| `12-trips.md` | Multiple road trips: parent-only start/end, per-trip history |
