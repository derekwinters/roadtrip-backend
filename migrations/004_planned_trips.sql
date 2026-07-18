-- Planned trips (docs/spec/12-trips.md, TRIP-013..017): a parent can stage the next road
-- trip before the family leaves. A planned trip has NO [started_at, ended_at) window —
-- started_at becomes nullable and is only set at activation — so the association rule,
-- the engine epochs, and the default read scope all ignore it. planned_start_at is
-- informational only (TRIP-016).

ALTER TABLE trips DROP CONSTRAINT trips_status_check;
ALTER TABLE trips ADD CONSTRAINT trips_status_check CHECK (status IN ('planned', 'active', 'ended'));

ALTER TABLE trips ADD COLUMN planned_start_at TIMESTAMPTZ;

ALTER TABLE trips ALTER COLUMN started_at DROP NOT NULL;
ALTER TABLE trips ALTER COLUMN started_at DROP DEFAULT;
-- Only planned trips may lack a window start; activation always sets one (TRIP-015).
ALTER TABLE trips ADD CONSTRAINT trips_started_at_present CHECK (status = 'planned' OR started_at IS NOT NULL);

-- At most one planned trip at a time (TRIP-013), complementing the one-active rule.
CREATE UNIQUE INDEX trips_single_planned_idx ON trips (status) WHERE status = 'planned';
