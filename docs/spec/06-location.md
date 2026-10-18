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
- **Arrival** — being stopped within `arrival_radius_m` of the **active** destination:
  while a stop is open, any ping within `arrival_radius_m` of the active destination arrives
  there. Triggers the leg summary and advances the tracker to the next destination. Because
  it is re-evaluated for the whole life of the stop (not only at the opening ping), a
  destination that becomes active while the vehicle is *already* parked within range still
  arrives (LOC-012).
- **Manual leg end** — a safety net for when automatic arrival never fires: a parent can
  mark the active destination arrived at the request time via `POST /api/trip/leg/end`
  (LOC-013). Unlike an automatic arrival it is timestamped at *now* (not backdated to a
  stop), does not consume any open stop, and does **not** auto-advance — the next leg only
  begins when a destination is next made active (in the app's flow, when the next pin is
  added). It records the leg summary exactly like an automatic arrival.
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
| LOC-006 | While a stop is open, a ping within `arrival_radius_m` of the active destination emits `trip.leg.arrived` for that destination (once), marks it `arrived` (backdated to the stop's start), and activates the next pending destination. | auto |
| LOC-012 | Arrival is re-evaluated on every ping for the duration of the open stop, not only at the opening ping: a destination that becomes the active destination while the vehicle is already stopped within `arrival_radius_m` of it arrives at that stop rather than being missed until the next stop. | auto |
| LOC-013 | `POST /api/trip/leg/end` (parent-only, online) marks the current `active` destination `arrived` at the request time and records its leg summary, but does **not** advance — no destination is auto-activated, so the next leg only starts when a destination is next made active. Returns 409 (`conflict`, "No active leg to end") when no destination is active. The manual `trip.leg.arrived` event (actor = the parent, `manual:true`) is replayed interleaved with pings during read-model rebuild (SYS-002), so live and rebuilt legs/destinations are byte-for-byte identical. | auto |
| LOC-007 | Trip mileage and per-leg mileage equal the haversine sum along consecutive breadcrumb pings, within 0.5% of the reference value in simulator scenarios. | auto |
| LOC-008 | `GET /api/map` returns: latest position + its timestamp, trip start point, breadcrumb (optionally decimated via `max_points`), active destination, remaining straight-line distance to it, and leg progress (miles driven this leg). | auto |
| LOC-009 | The leg summary payload contains: wall-clock duration, moving duration (wall minus journal-worthy stop time), miles, journal-worthy stop count, states crossed during the leg, and games finished during the leg. | auto |
| LOC-010 | Out-of-order or duplicate-timestamp pings within a sync batch are processed in `client_ts` order; a ping older than the newest processed ping is folded into the breadcrumb in timestamp order but never retroactively reopens closed stops. | auto |
| LOC-011 | GPS jitter tolerance: the ±50 m jitter simulator scenario at a 15-minute stop still yields exactly one stop (no flapping start/end pairs). | auto |

## Stop labels

A stop's automatic name is its `place` (GEO-006), which is null when no city is within
`city_radius_km` and for every stop that is not journal-worthy. A parent can give **any**
stop (journal-worthy or not, open or ended) a user-supplied **label** — "Grandma's",
"Rest area" — through the client-originated `location.stop.labeled {stop_id, label}` event,
uploaded through `POST /api/sync/batch` like any other offline event. The label is
**additive**: `place` is kept and still returned; clients display `label` in preference to
`place` when both are present. Labeling a stop that is not journal-worthy also makes it
visible in the checklist (LIST-003), so a stop that missed a city can be found and named; it
does **not** make the stop journal-worthy (JRNL-004 and LOC-005 are unchanged).

Invariants:

- Never mutate or drop `place`, `journal_worthy`, or any stored `location.stop.*` event when a
  label is set — the label lives only in `location.stop.labeled` events and is folded in at read time.
- Resolve a stop's current label as the `location.stop.labeled` event for that `stop_id` with the
  greatest `client_ts` (ties broken by `seq`) — never by upload order.
- Never truncate an over-length label; reject it.

| ID | Requirement | Verify |
|----|-------------|--------|
| LOC-014 | `location.stop.labeled {stop_id, label}` is accepted through `POST /api/sync/batch` from parent profiles and stored as an append-only event with its real `client_ts`; a kid profile's label event is rejected per-event with reason `not_parent` and not persisted (as EVT-005). | auto |
| LOC-015 | The label is trimmed before it is stored; a label that is empty after trimming, or longer than `stop_label_max_chars` (config, CFG-008) after trimming, is rejected per-event (`rejected`, reason `label must not be blank` / `label_too_long`) and not persisted. | auto |
| LOC-016 | A `location.stop.labeled` whose `stop_id` names no stop in the stops read model is rejected per-event with reason `unknown_stop` and not persisted. | auto |
| LOC-017 | The stops read model exposes a stop's current label as `label` next to `place`: re-labeling the same `stop_id` is last-write-wins by `client_ts` (ties by `seq`), so a late-synced older label never overwrites a newer one; `place` is returned unchanged; a stop that was never labeled reads back exactly as before (no `label` field). | auto |

## Requirements — reverse geocoding (server-side, offline)

Datasets bundled in the repo/image (no runtime internet): US state polygons
(`data/us-states.geojson`, simplified) and a US city list with lat/lon + population
(`data/us-cities.json`). The city list holds **every** US place in the `all-the-cities` package
(about 16,700, regenerated by `npm run build:data`) with no population cutoff; which places count
as cities is decided at runtime by `city_min_population` (GEO-009).

Invariants:

- Filter by population at lookup time, never by trimming the bundled file — changing
  `city_min_population` must not need a rebuild or a new image.
- Record a visited city in exactly one place: the `cities_visited` read model's per-trip
  uniqueness (TRIP-006). The pass-through (GEO-004) and stop (GEO-008) paths share it, so a city
  reached both ways yields one row and one `location.crossing.city`, whichever path came first.
- A stop-recorded city emits the same `location.crossing.city` payload as a pass-through one;
  clients must not need to distinguish them.

| ID | Requirement | Verify |
|----|-------------|--------|
| GEO-001 | Every ping is annotated with a state via point-in-polygon lookup against the bundled state polygons, entirely server-side. | auto |
| GEO-002 | A ping whose state differs from the previous ping's state emits `location.crossing.state` with the new and previous state codes. | auto |
| GEO-003 | The first ping of the trip emits `location.crossing.state` (prev = null) so the starting state is checklisted. | auto |
| GEO-004 | While `track_cities_through` is true, a ping within `city_radius_km` of the centroid of a city at or above `city_min_population` marks the nearest such city visited; each city is recorded at most once per trip (`location.crossing.city`). | auto |
| GEO-005 | Points outside all state polygons (e.g. over water/border gaps) keep the previous state — no crossing event is emitted on lookup misses. | auto |
| GEO-006 | Journal-worthy stops are annotated with the nearest city (at or above `city_min_population`) within `city_radius_km` of the stop anchor as `place` when one exists, regardless of `track_cities_stopped`. | auto |
| GEO-007 | While `track_cities_through` is false, pings record no visited city and emit no `location.crossing.city` (stops still follow GEO-006/GEO-008). | auto |
| GEO-008 | While `track_cities_stopped` is true, a journal-worthy stop whose `place` city exists also records that city visited, deduped per trip with GEO-004 (TRIP-006): `location.crossing.city` `{city, state_code}` is emitted only when the city was not already recorded this trip, stamped with the stop's start (`first_at` = stop `started_at`). While false, the stop records no visited city. | auto |
| GEO-009 | Places in the bundled list whose population is below `city_min_population` are never matched by city lookup (GEO-004/GEO-006/GEO-008), even when nearer than a qualifying city; the threshold is read per batch, so a change affects only pings processed afterwards. | auto |
