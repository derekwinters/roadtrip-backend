# 05 — Runtime Configuration

All detection thresholds are **runtime-tunable** and **parent-configurable** (resolved design
decision). Nothing in the location engine hardcodes them. The same mechanism lets tests and the
simulator tighten intervals.

## Keys, defaults, bounds

| Key | Default | Bounds | Meaning |
|-----|---------|--------|---------|
| `ping_interval_s` | 300 | 5–3600 | Expected cadence of parent-phone pings (client reads this). |
| `stop_radius_m` | 100 | 20–1000 | Two consecutive pings within this distance ⇒ stationary. |
| `min_stop_duration_min` | 10 | 1–240 | Stops at least this long are journal-worthy and counted in summaries. |
| `arrival_radius_m` | 800 | 100–5000 | Stop within this distance of the active destination ⇒ arrival (~0.5 mi default). |
| `city_radius_km` | 10 | 1–50 | Ping within this distance of a city centroid ⇒ city visited. |

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| CFG-001 | `GET /api/config` returns all keys with current values; readable by any profile. | auto |
| CFG-002 | `PUT /api/config` accepts a partial object of known keys, is parent-only, and rejects unknown keys (400) and out-of-bounds values (400) without applying any part of the batch. | auto |
| CFG-003 | Config changes emit a `config.updated` event containing exactly the changed keys and take effect for the next processed ping without a server restart. | auto |
| CFG-004 | The location engine reads every threshold from config: changing `stop_radius_m`, `min_stop_duration_min`, or `arrival_radius_m` observably changes detection behavior in tests. | auto |
| CFG-005 | Defaults above are seeded on first startup; missing keys self-heal to defaults on boot. | auto |
