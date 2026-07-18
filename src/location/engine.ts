import type pg from 'pg'
import type { EventBus } from '../bus.js'

/**
 * Location engine entry point (docs/spec/06-location.md). Called by the sync route with the
 * seqs of newly accepted location.ping events; processes them in client_ts order (SYNC-005),
 * deriving stops, crossings, arrivals, mileage, and leg summaries.
 *
 * OWNER: location feature (see issue tracker). Stub until implemented.
 */
export async function processNewPings(_pool: pg.Pool, _bus: EventBus, _pingSeqs: number[]): Promise<void> {
  // Implemented in the location pipeline feature.
}
