# 13 — Address Search (Geocode Proxy)

Parents plan destinations by searching for an address or place name instead of typing
coordinates. The server proxies a public forward-geocoding service (Nominatim), because the
bundled offline datasets (see `06-location.md`) only support *reverse* geocoding of US
states/cities — they cannot resolve free-text addresses.

**SYS-007 clarification.** SYS-007 (the server functions with zero outbound internet access)
continues to hold for everything the trip runtime depends on: pings, stops, crossings,
journal, games, and summaries never make outbound calls. `GET /api/geocode` is the single,
explicitly **best-effort online** endpoint, used for trip *planning* while the home server
has connectivity. Offline it degrades to the persistent cache, and on a cache miss it fails
cleanly with 503 — trip runtime behavior is unaffected either way.

## Behavior

- `GET /api/geocode?q=<text>` is parent-only: address search exists to add/edit
  destinations, which is a parent action (see `04-profiles.md`).
- Upstream is Nominatim search (`https://nominatim.openstreetmap.org/search`) called with
  `format=jsonv2` and `limit=5`, and a descriptive `User-Agent`
  (`roadtrip-backend (self-hosted family app)`) as the Nominatim usage policy requires.
- Upstream responses are reduced to at most 5 `{display_name, lat, lon}` matches
  (`lat`/`lon` as numbers).
- Results persist in the `geocode_cache` table, keyed by the normalized query (trimmed,
  whitespace-collapsed, lower-cased), with no expiry — so a query repeated mid-trip works
  after connectivity is gone. The cache is a plain snapshot of an external service response,
  not a domain occurrence, so it intentionally lives outside the `events` stream (SYS-001
  governs domain state; rebuilding read models neither needs nor touches this cache).
- Upstream calls are throttled in-process to ≥ 1 second spacing (Nominatim's absolute
  maximum of one request per second); concurrent cache misses queue behind one another
  instead of hitting upstream in parallel, and concurrent *identical* queries share a single
  upstream call.
- The upstream fetcher, spacing, and timeout are injection points of the search service
  (defaults: real Nominatim, 1100 ms spacing, 5 s timeout). Tests always inject a stub
  fetcher — the test suite never calls the real Nominatim.

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| GSR-001 | `GET /api/geocode?q=` is parent-only: kid profiles receive 403 with `error.code = "parent_required"`; missing/unknown profiles receive 401. | auto |
| GSR-002 | The endpoint proxies the configured upstream (Nominatim search, `format=jsonv2`, `limit=5`) with the descriptive `User-Agent` `roadtrip-backend (self-hosted family app)`, returning up to 5 `{display_name, lat, lon}` matches with numeric coordinates. | auto |
| GSR-003 | Identical queries (after trim/whitespace-collapse/lower-case normalization) are served from the persistent `geocode_cache` table without re-calling upstream; the cache survives server restarts and keeps serving after connectivity loss. | auto |
| GSR-004 | An upstream failure, timeout, or offline server without a cache hit returns 503 with `error.code = "geocode_unavailable"`; the cache is not polluted. | auto |
| GSR-005 | Upstream calls are throttled to ≥ 1 s start-to-start spacing (Nominatim policy); concurrent requests queue for the single upstream slot rather than calling upstream in parallel. | auto |
