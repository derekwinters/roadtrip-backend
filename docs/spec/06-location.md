# 06 — Location Pipeline (LOC) & Reverse Geocoding (GEO)

The location engine processes each accepted `location.ping` synchronously (in ingestion
order) and derives stops, crossings, arrivals, mileage, and leg summaries. All thresholds come
from config (`05-config.md`).

## Definitions

- **Breadcrumb** — the ordered list of pings for the trip; mileage is the sum of haversine
  distances between consecutive pings (never straight-line between endpoints).
- **Stationary pair** — two consecutive pings whose distance ≤ `stop_radius_m`.
- **Stop** — begins (retroactively) at the first ping of a stationary run; ends at the first
  ping farther than `stop_radius_m` from the stop's anchor (the first stationary ping).
  Accepted quirk: long traffic jams may register as stops.
- **Journal-worthy stop** — duration ≥ `min_stop_duration_min`.
- **Arrival** — a stop whose anchor lies within `arrival_radius_m` of the **active**
  destination. Triggers the leg summary and advances the tracker to the next destination.
- **Leg** — the span between trip start (or previous arrival) and an arrival.
- **Trip epoch** (TRIP-006, see `12-trips.md`) — the engine scopes its accumulators to the
  trip containing the ping being processed. Leg numbering under LOC-006/LOC-009 restarts per
  trip (a fresh trip begins at leg 0), the active destination is the lowest-ordered
  non-arrived destination *of that trip*, and each city is collected once per trip (refines
  GEO-004's "once per trip"). With no trips defined there is a single implicit epoch and
  behavior is unchanged.

## Destinations

Parents maintain an ordered destination list (`POST/PATCH/DELETE /api/destinations`). Exactly
one destination is `active` (the lowest-ordered non-arrived one); the rest are `pending` or
`arrived`. Kids' map shows only start / current position / active destination (client concern,
see android spec), but the API serves the full list with roles enforced client-side — the data
is not secret, the presentation differs.

## Requirements — location engine

| ID | Requirement | Verify |
|----|-------------|--------|
| LOC-001 | Pings are accepted only from parent profiles; each accepted ping appends to the breadcrumb and is processed exactly once by the engine (idempotent re-sync of the same `event_id` does not double-process). | auto |
| LOC-002 | Two consecutive pings within `stop_radius_m` of each other open a stop anchored at the first ping of the run. | auto |
| LOC-003 | The `location.stop.started` event's `client_ts` is **backdated** to the first stationary ping's timestamp. | auto |
| LOC-004 | A ping farther than `stop_radius_m` from the stop anchor ends the stop; `location.stop.ended` carries `started_at`, `ended_at`, and `duration_min` computed from ping timestamps. | auto |
| LOC-005 | Stops shorter than `min_stop_duration_min` produce a `stop.ended` event flagged `journal_worthy=false` and are excluded from the journal and summary stop counts. | auto |
| LOC-006 | A stop whose anchor is within `arrival_radius_m` of the active destination emits `trip.leg.arrived` for that destination (once), marks it `arrived`, and activates the next pending destination. | auto |
| LOC-007 | Trip mileage and per-leg mileage equal the haversine sum along consecutive breadcrumb pings, within 0.5% of the reference value in simulator scenarios. | auto |
| LOC-008 | `GET /api/map` returns: latest position + its timestamp, trip start point, breadcrumb (optionally decimated via `max_points`), active destination, remaining straight-line distance to it, and leg progress (miles driven this leg). | auto |
| LOC-009 | The leg summary payload contains: wall-clock duration, moving duration (wall minus journal-worthy stop time), miles, journal-worthy stop count, states crossed during the leg, and games finished during the leg. | auto |
| LOC-010 | Out-of-order or duplicate-timestamp pings within a sync batch are processed in `client_ts` order; a ping older than the newest processed ping is folded into the breadcrumb in timestamp order but never retroactively reopens closed stops. | auto |
| LOC-011 | GPS jitter tolerance: the ±50 m jitter simulator scenario at a 15-minute stop still yields exactly one stop (no flapping start/end pairs). | auto |

## Requirements — reverse geocoding (server-side, offline)

Datasets bundled in the repo/image (no runtime internet): US state polygons
(`data/us-states.geojson`, simplified) and a US city list with lat/lon + population
(`data/us-cities.json`).

| ID | Requirement | Verify |
|----|-------------|--------|
| GEO-001 | Every ping is annotated with a state via point-in-polygon lookup against the bundled state polygons, entirely server-side. | auto |
| GEO-002 | A ping whose state differs from the previous ping's state emits `location.crossing.state` with the new and previous state codes. | auto |
| GEO-003 | The first ping of the trip emits `location.crossing.state` (prev = null) so the starting state is checklisted. | auto |
| GEO-004 | A ping within `city_radius_km` of a city centroid marks that city visited; each city is recorded at most once per trip (`location.crossing.city`). | auto |
| GEO-005 | Points outside all state polygons (e.g. over water/border gaps) keep the previous state — no crossing event is emitted on lookup misses. | auto |
| GEO-006 | Journal-worthy stops are annotated with the nearest city within `city_radius_km` as `place` when one exists. | auto |
