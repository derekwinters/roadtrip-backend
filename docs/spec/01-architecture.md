# 01 — System Architecture

## Topology

```
[Parent phone]──┐            in-car hotspot + VPN             ┌──[PostgreSQL 16]
[Parent phone]──┤  ───────────── HTTPS/JSON ─────────────►    │      ▲
[Kid tablet  ]──┤            [Fastify API server]─────────────┘  docker-compose
[Kid tablet  ]──┘             (roadtrip-backend)                on home server
```

- The home server runs `docker compose up`: one API container, one PostgreSQL container.
- Clients reach the API over the VPN; there is no cloud dependency and no third-party service
  at runtime (reverse geocoding is served from bundled offline datasets).
- The **parent phone is the single GPS authority**. Tablets never request location permissions.

## Event-sourced core

A single append-only `events` table is the backbone. Every feature is a producer of events, a
read model over them, or both (see `02-event-model.md`).

| Producer | Events |
|----------|--------|
| Parent phone | `location.ping` |
| Server (location engine) | `location.stop.started/ended`, `location.crossing.state/city`, `trip.leg.arrived` |
| Any profile | `journal.post` |
| Game endpoints | `game.created/joined/move/finished/abandoned` |
| Parent admin | `destination.*`, `config.updated`, `profile.*` |

| Read model | Source |
|-----------|--------|
| Journal feed | journal-worthy event types, ordered by timestamp |
| Map state | latest ping, breadcrumb, destinations, leg progress |
| Checklist | crossing + stop events |
| Game state / replay / spectate | `game.*` stream per game |
| Leg & trip summaries | aggregations over pings, stops, crossings, games |

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| SYS-001 | The system stores every domain occurrence as a row in the append-only `events` table; no feature deletes or mutates existing events. | auto |
| SYS-002 | All read models (journal, map state, checklist, game state, summaries) are derivable purely from the event stream: rebuilding them from events yields identical results. | auto |
| SYS-003 | The API server and PostgreSQL run as two containers defined in `docker-compose.yml`; the API waits for the database to be healthy before serving. | manual |
| SYS-004 | The server runs migrations automatically at startup and is idempotent across restarts. | auto |
| SYS-005 | The server exposes `GET /api/health` returning `{status:"ok", version}` for connectivity checks (used by clients to detect online state). | auto |
| SYS-006 | All timestamps are stored and served as UTC ISO-8601; clients render local time. | auto |
| SYS-007 | The server functions with zero outbound internet access (geocoding datasets are bundled; no third-party runtime calls). | manual |
| SYS-008 | A request is never trusted for identity beyond the `X-Profile-Id` header (no passwords, per product decision); parent-only routes verify the referenced profile has the parent role. | auto |

## Technology choices (normative)

- **Node 22 + TypeScript (strict) + Fastify 5** — API server.
- **PostgreSQL 16** — storage; access via `pg` (node-postgres); SQL migrations in `migrations/`
  applied by a built-in runner (SYS-004); no ORM.
- **Zod** — request/response validation at the edge.
- **chess.js** — chess rule enforcement (per design doc: use an existing library).
- **Vitest** — tests. Integration tests use a real PostgreSQL (never mocked SQL).
- The OpenAPI document (`docs/spec/openapi.yaml`) is the API contract; routes are implemented
  from it, not vice versa.
