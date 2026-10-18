# 15 — Operational Log (OPLOG)

A small, durable record of operational failures an operator wants to diagnose later — after the
process log is gone, for example because the container restarted mid-trip. It is **opt-in**:
a feature writes an entry only where its code explicitly chooses to record one. Geocode
failures (see `13-geocode-search.md`, GSR-007) are its first user.

The operational log is a plain operational record, not a domain occurrence. Like the
`geocode_cache` table it lives **outside** the `events` stream (SYS-001 governs domain state
only): read-model rebuilds neither need nor touch it, and nothing in the trip runtime reads it.

## Storage

The `operational_log` table, added by a migration:

| Column | Meaning |
|--------|---------|
| `id` | Monotonic insertion order (`BIGSERIAL`); "oldest" means lowest `id`. |
| `recorded_at` | When the entry was written (server clock, `TIMESTAMPTZ`). |
| `source` | The recording feature, e.g. `geocode`. |
| `code` | A stable machine code, e.g. `geocode_upstream_error`. |
| `detail` | A short JSON object with the context the caller chooses, e.g. `{"query": "denver", "upstream_status": 429}`. |

## Read-back

There is **no API surface**. An operator reads the log directly from the database, e.g.

```sql
SELECT recorded_at, source, code, detail FROM operational_log ORDER BY id DESC LIMIT 50;
```

## Retention

The table keeps at most `operational_log_max_rows` entries (a runtime config key, see
`05-config.md`, CFG-007; default 1000). The limit is a row count, not a size in bytes. When
recording an entry takes the table over the limit, the oldest entries are removed.

## Invariants

- **The facility must not capture log output or requests wholesale.** It is not a log sink
  or request logger: there is no hook on the HTTP server, the process logger, or the error
  handler that writes to it. Only an explicit `record` call by a feature writes an entry.
- **A logging failure must not turn a response into a different error.** Recording is
  best-effort: a failed write is reported to the process log and swallowed, and the
  triggering request returns exactly what it would have returned without the operational log.

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| OPLOG-001 | A migration adds the `operational_log` table (`id`, `recorded_at`, `source`, `code`, `detail`) outside the `events` stream; recording an entry appends no event. | auto |
| OPLOG-002 | Opt-in only: no entry is written unless a caller explicitly records one. Ordinary requests — including failing ones (404, 400 validation, 403) — write nothing. | auto |
| OPLOG-003 | Each entry stores its timestamp, source, code, and the caller's short JSON detail, readable back directly from the database. | auto |
| OPLOG-004 | Retention: after recording, the table holds at most `operational_log_max_rows` entries (CFG-007), read from config at record time; with the limit at N, recording N+1 entries leaves N with the oldest removed. | auto |
| OPLOG-005 | Recording is best-effort: a failure to write an entry (or to apply retention) never throws to the caller and never changes or breaks the triggering request; the failure is reported to the process log. | auto |
