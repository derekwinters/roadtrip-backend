-- Operational log (docs/spec/15-operational-log.md, OPLOG-001).
-- A small, durable, opt-in record of operational failures (first user: geocode failures,
-- GSR-007) so the reason survives a process restart. Like geocode_cache it is a plain
-- operational record, not a domain occurrence, so it lives outside the events stream
-- (SYS-001 governs domain state only) and is neither cleared nor rebuilt by read-model
-- rebuilds. Retention is a row count from config (operational_log_max_rows, CFG-007).

CREATE TABLE operational_log (
  id          BIGSERIAL PRIMARY KEY,               -- insertion order; "oldest" = lowest id
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source      TEXT NOT NULL,                       -- recording feature, e.g. 'geocode'
  code        TEXT NOT NULL,                       -- stable machine code, e.g. 'geocode_upstream_error'
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb   -- short caller-chosen context
);
