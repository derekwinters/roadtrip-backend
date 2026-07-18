# roadtrip-backend

Backend API + database for the Family Road Trip app. TypeScript + Fastify + PostgreSQL,
event-sourced around a single `events` table. Ships as a Docker container next to a Postgres
container (see `docker-compose.yml`).

## Development methodology (mandatory)

This project is **spec-driven** and **test-driven**. All feature/infrastructure work goes
through the `roadtrip-dev` agent workflow defined in `.claude/agents/roadtrip-dev.md`:

1. **Spec first** — update `docs/spec/*.md` (+ `docs/spec/openapi.yaml` for API surface).
   Every behavior has a requirement ID (`AREA-NNN`).
2. **Tests second** — failing tests referencing the requirement IDs (`[LOC-006]` in the test
   name or `// covers: LOC-006`).
3. **Implement** — minimal code to green; tunables come from config, never hard-coded.
4. **Validate** — `npm run validate:specs` and `npm test` must pass.

## Commands

- `npm test` — full Vitest suite (unit + integration; integration needs Postgres, see below)
- `npm run test:unit` — unit tests only (no database needed)
- `npm run validate:specs` — spec/requirement/docs validation (also runs in CI)
- `npm run lint` / `npm run typecheck`
- `./scripts/test-db.sh` — start a throwaway Postgres for integration tests
- `npm run simulate -- --scenario <name>` — GPS trip simulator against a running server
- `npm run seed:demo` — populate a demo trip (pings, stops, games, journal posts)
- `docker compose up` — API + Postgres

## Conventions

- Conventional Commits (release-please manages versioning + CHANGELOG).
- Append-only event stream; features are producers/read-models over `events`.
- Requirement areas: SYS, EVT, API, PRO, CFG, SYNC, LOC, GEO, GSR, JRNL, LIST, GAME, SUM, NOTIF, SIM, TRIP.
