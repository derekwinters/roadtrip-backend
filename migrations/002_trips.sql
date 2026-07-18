-- Trips (docs/spec/12-trips.md): multiple named road trips over the app's lifetime.
-- The trips table is the read model over trip.started / trip.ended events; every event
-- (and the location read models) carries a nullable trip_id resolved from the trip whose
-- [started_at, ended_at) window contains its client timestamp (TRIP-004).

CREATE TABLE trips (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at   TIMESTAMPTZ
);
-- At most one active trip at a time (TRIP-001).
CREATE UNIQUE INDEX trips_single_active_idx ON trips (status) WHERE status = 'active';

ALTER TABLE events ADD COLUMN trip_id UUID REFERENCES trips(id);
CREATE INDEX events_trip_id_idx ON events (trip_id);

ALTER TABLE destinations   ADD COLUMN trip_id UUID REFERENCES trips(id);
ALTER TABLE stops          ADD COLUMN trip_id UUID REFERENCES trips(id);
ALTER TABLE legs           ADD COLUMN trip_id UUID REFERENCES trips(id);
ALTER TABLE cities_visited ADD COLUMN trip_id UUID REFERENCES trips(id);

-- Leg numbering restarts per trip and cities are collected once per trip (TRIP-006).
-- NULL trip_id (activity outside any trip) coalesces to a sentinel so the pre-trips
-- uniqueness semantics still hold for the implicit epoch.
ALTER TABLE legs DROP CONSTRAINT legs_pkey;
CREATE UNIQUE INDEX legs_trip_leg_idx
  ON legs ((COALESCE(trip_id, '00000000-0000-0000-0000-000000000000'::uuid)), leg_index);

ALTER TABLE cities_visited DROP CONSTRAINT cities_visited_pkey;
CREATE UNIQUE INDEX cities_visited_trip_city_idx
  ON cities_visited ((COALESCE(trip_id, '00000000-0000-0000-0000-000000000000'::uuid)), city, state_code);
