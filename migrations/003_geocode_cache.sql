-- Address search cache (docs/spec/13-geocode-search.md, GSR-003).
-- Persistent per-query results from the Nominatim proxy, so a repeated search keeps
-- working after connectivity is gone and across server restarts. This is a plain
-- snapshot of an external service response — not domain state — so it intentionally
-- lives outside the events stream (SYS-001 governs domain occurrences only) and is
-- neither cleared nor rebuilt by read-model rebuilds.

CREATE TABLE geocode_cache (
  query      TEXT PRIMARY KEY,      -- normalized: trimmed, whitespace-collapsed, lower-cased
  results    JSONB NOT NULL,        -- up to 5 {display_name, lat, lon} matches
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
