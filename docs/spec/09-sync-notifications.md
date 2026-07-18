# 09 — Offline Sync (SYNC) & Notifications (NOTIF)

## Sync model

- **Upload**: clients queue client-originated events (`journal.post`, `location.ping`) locally
  while offline, each with a client-generated UUID `event_id` and `client_ts`, then flush via
  `POST /api/sync/batch` on reconnect. The server answers per-event:
  `accepted | duplicate | rejected{reason}`. Journal entries are append-only ⇒ no conflict
  resolution; ordering is by timestamp (JRNL-002).
- **Download**: clients keep a cursor (`seq`) and pull `GET /api/events?after=<cursor>` —
  optionally long-polling with `wait` (EVT-008). Everything a client renders comes through this
  one feed plus the read-model endpoints.
- **Game actions are online-only** (design decision): they go through the game endpoints and
  are never queued offline — turn-based play requires the server to arbitrate turns; ~1s VPN
  latency is acceptable.

## Requirements — sync

| ID | Requirement | Verify |
|----|-------------|--------|
| SYNC-001 | `POST /api/sync/batch` accepts up to 500 events and reports a per-event status array in input order; the whole batch is processed even when some events are rejected. | auto |
| SYNC-002 | Retrying a batch (same `event_id`s) after a lost response yields `duplicate` for the already-stored events and stores nothing twice — exactly-once effect from at-least-once delivery. | auto |
| SYNC-003 | Events synced late (older `client_ts` than existing events) appear at their correct chronological place in the journal (mixed online/offline interleaving from multiple devices). | auto |
| SYNC-004 | Batch events are validated individually: one malformed event yields `rejected` for that event only, never a whole-batch failure. | auto |
| SYNC-005 | Pings arriving in one flushed batch are processed by the location engine in `client_ts` order, producing the same stops/crossings/arrivals as if they had arrived live (offline drive reconstruction). | auto |

## Notifications

No push infrastructure (home server, VPN) — notification are **derived from the event feed**
and surfaced by clients as local notifications. The server provides a per-profile notification
view so clients don't re-implement the rules. Applies to phones **and** tablets (resolved
decision), for **both** triggers: challenge received and journal activity.

| ID | Requirement | Verify |
|----|-------------|--------|
| NOTIF-001 | `GET /api/notifications?after=<seq>` (profile from header) returns notification items derived from events after the cursor, each with kind, text, related ids, and the event `seq` for cursor advance. | auto |
| NOTIF-002 | A `game.created` challenge inviting profile P yields a `challenge_received` notification for P only. | auto |
| NOTIF-003 | A `journal.post` by profile A yields a `journal_activity` notification for every profile except A. | auto |
| NOTIF-004 | Automatic journal events (state crossings, leg arrivals, journal-worthy stops, game results) yield `journal_activity` notifications for all profiles except the actor (if any); non-journal events (pings, moves) never notify. | auto |
| NOTIF-005 | The endpoint supports `wait` long-polling like the events feed so foreground clients can surface notifications within seconds. | auto |
