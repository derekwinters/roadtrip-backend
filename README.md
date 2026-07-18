# roadtrip-backend

Event-sourced backend for the **Family Road Trip app**: a shared travel journal that populates
itself from trip events — location pings from the parent phone, automatically detected stops,
state/city crossings, turn-based games, leg arrivals — plus manual posts from any family
member. Runs on a home server behind the car-hotspot VPN; clients stay usable offline and sync
when connectivity returns.

## Quick start

Pull-only (no checkout, no build — grab `docker-compose.release.yml` from the latest
[release](https://github.com/derekwinters/roadtrip-backend/releases)):

```bash
docker compose -f docker-compose.release.yml up -d   # GHCR image + stock postgres
```

From a checkout:

```bash
docker compose up --build        # API on :8080 + PostgreSQL 16
npm run seed:demo                # optional: populate a fabricated demo day
```

Development:

```bash
npm install
source <(./scripts/test-db.sh)   # throwaway Postgres for tests
npm test                         # unit + integration + scenario suites
npm run validate:specs           # spec/documentation validation
npm run dev                      # tsx watch mode (needs DATABASE_URL)
npm run simulate -- --url http://localhost:8080 --scenario gas_stop --profile <parent-uuid>
```

## How it works

One append-only `events` table is the system of record. Features are producers of events or
read models over them:

- **Journal** — chronological feed of posts, journal-worthy stops, state crossings, game
  results, and leg summaries, each deep-linking to its source.
- **Map/progress** — breadcrumb, current position, active destination, leg mileage.
- **Location engine** — server-side stop detection (backdated to the first stationary ping),
  offline reverse geocoding from bundled datasets, arrival detection, leg summaries.
- **Games** — chess, checkers, tic-tac-toe, ultimate tic-tac-toe, hangman; every move is an
  event, which gives lobby, challenges, spectating, and replays from one design.
- **Sync** — clients upload queued events with client-generated UUIDs; retries are idempotent;
  downloads are cursor-paged with long-polling.

The full specification lives in [docs/spec/](docs/spec/00-overview.md) — start with the
overview. Every behavior carries a requirement ID; CI fails if a testable requirement loses
its test or the OpenAPI contract drifts from the implemented routes.

## Releases

Conventional commits + release-please: PR builds upload a Docker image tarball as artifacts,
`main` builds publish release-candidate prereleases while a release PR is open, and versioned
releases get the final image + compose bundle + OpenAPI attached to the release notes.
Nothing is published to registries or stores.
