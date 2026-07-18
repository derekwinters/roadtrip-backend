# 14 — License Plate Bingo (BNG)

The classic long-drive game: the family fills one shared card of US license plates as they
spot them. Any profile — kids included — taps a state to mark it spotted; the first standing
spotter keeps the credit. Plate taps work offline exactly like journal posts: they queue on
the device with real client timestamps and sync when connectivity returns.

## Design

- Two **client-originated** events, `plate.spotted` / `plate.unspotted`, payload
  `{state_code}`, whitelisted through the sync batch exactly like `journal.post` (EVT-004's
  catalog is extended accordingly). `state_code` is one of the 51 two-letter uppercase codes
  from the bundled `data/us-states.geojson` dataset (the 50 states plus DC); anything else
  is rejected per-event.
- **No side tables**: the card is a pure fold (`src/bingo/card.ts`) over the trip's
  `plate.*` events in `client_ts` order (`seq` as tie-break), so offline-queued spots land
  where they happened — the same clock-of-record principle as the journal (JRNL-002).
- The fold is idempotent: spotting an already-spotted state or removing an empty one is a
  no-op. A removal is honored only when it comes from the cell's original spotter or from a
  parent (BNG-003); anyone else's removal stays in the event stream but never changes the
  card. A cell's credit is the earliest spot since the cell was last empty — so a
  removed-then-respotted state credits the respotter, and duplicate spots never steal credit.
- `GET /api/bingo` returns the spotted cells, the chronological log of **effective** spots
  and removals (no-ops and ignored removals are omitted from the log; the raw events remain
  in `/api/events`), and per-profile standing counts. Scoped per trip like every other read
  model (TRIP-007).
- Bingo is deliberately quiet: `plate.*` events are not journal-worthy and never produce
  notifications — the journal and notification derivations whitelist journal-worthy types
  and simply do not include them (BNG-005).

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| BNG-001 | `plate.spotted` and `plate.unspotted` `{state_code}` are client-originated sync events accepted from any profile (kids included) and stored with their real client timestamps; `state_code` must be a 2-letter uppercase code from the bundled states plus DC, and anything else is rejected per-event. | auto |
| BNG-002 | The card folds spot/unspot per (trip, state) in `client_ts` order idempotently: duplicate spots and unspots of empty states are no-ops; a cell's credit is the first standing spotter, and a removed-then-respotted state credits the respotter. | auto |
| BNG-003 | Removals are honored only when they come from the cell's original spotter or from a parent; anyone else's `plate.unspotted` is ignored by the fold while the event stays stored in the stream. | auto |
| BNG-004 | `GET /api/bingo` (`?trip=` scoped, default scope per TRIP-007) returns the spotted cells (`state_code`, `spotted_by`, `spotted_at`), the chronological log of effective spots and removals (actor and timestamp), and per-profile standing counts. | auto |
| BNG-005 | Bingo produces no journal entries and no notifications: `plate.*` events never appear in the journal feed and never yield notification items. | auto |
| BNG-006 | The demo seed includes a partially filled bingo card with one removal, and a scenario test proves per-trip isolation (two trips with disjoint cards; between-trip spots belong to neither). | auto |
