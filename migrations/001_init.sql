-- Family Road Trip — initial schema.
-- The events table is the system of record (SYS-001); everything else is a read model
-- rebuildable from it (SYS-002).

CREATE TABLE profiles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  avatar     TEXT NOT NULL DEFAULT '🙂',
  role       TEXT NOT NULL CHECK (role IN ('parent', 'kid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
  seq       BIGSERIAL PRIMARY KEY,
  event_id  UUID NOT NULL UNIQUE,
  type      TEXT NOT NULL,
  actor_id  UUID REFERENCES profiles(id),
  device_id TEXT,
  payload   JSONB NOT NULL DEFAULT '{}',
  client_ts TIMESTAMPTZ NOT NULL,
  server_ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_type_seq_idx ON events (type, seq);
CREATE INDEX events_client_ts_idx ON events (client_ts);

CREATE TABLE config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE destinations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  lat         DOUBLE PRECISION NOT NULL,
  lon         DOUBLE PRECISION NOT NULL,
  order_index INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'arrived')),
  arrived_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE games (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_type          TEXT NOT NULL CHECK (game_type IN ('chess','checkers','tictactoe','ultimate','hangman')),
  mode               TEXT NOT NULL CHECK (mode IN ('open','challenge')),
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','active','finished','abandoned')),
  created_by         UUID NOT NULL REFERENCES profiles(id),
  invited_profile_id UUID REFERENCES profiles(id),
  opponent_id        UUID REFERENCES profiles(id),
  options            JSONB NOT NULL DEFAULT '{}',
  -- Cached fold of the game's event stream; always rebuildable (GAME-006).
  state              JSONB,
  move_count         INTEGER NOT NULL DEFAULT 0,
  result             TEXT CHECK (result IN ('win','draw','abandoned')),
  winner_id          UUID REFERENCES profiles(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ
);
CREATE INDEX games_status_idx ON games (status, created_at);

-- Location engine read models -------------------------------------------------

CREATE TABLE pings (
  seq        BIGINT PRIMARY KEY REFERENCES events(seq),
  lat        DOUBLE PRECISION NOT NULL,
  lon        DOUBLE PRECISION NOT NULL,
  accuracy_m DOUBLE PRECISION,
  client_ts  TIMESTAMPTZ NOT NULL,
  state_code TEXT,
  leg_index  INTEGER NOT NULL
);
CREATE INDEX pings_client_ts_idx ON pings (client_ts);

CREATE TABLE stops (
  id                     UUID PRIMARY KEY,
  anchor_lat             DOUBLE PRECISION NOT NULL,
  anchor_lon             DOUBLE PRECISION NOT NULL,
  started_at             TIMESTAMPTZ NOT NULL,
  ended_at               TIMESTAMPTZ,
  duration_min           DOUBLE PRECISION,
  journal_worthy         BOOLEAN,
  place                  TEXT,
  leg_index              INTEGER NOT NULL,
  arrival_destination_id UUID REFERENCES destinations(id)
);

CREATE TABLE cities_visited (
  city       TEXT NOT NULL,
  state_code TEXT NOT NULL,
  first_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (city, state_code)
);

-- Single-row incremental state for the location engine (last ping, open stop,
-- mileage accumulators, current leg). Rebuildable from the event stream.
CREATE TABLE engine_state (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  data JSONB NOT NULL
);

CREATE TABLE legs (
  leg_index      INTEGER PRIMARY KEY,
  destination_id UUID REFERENCES destinations(id),
  started_at     TIMESTAMPTZ NOT NULL,
  arrived_at     TIMESTAMPTZ,
  summary        JSONB
);
