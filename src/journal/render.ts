/**
 * Journal read model: renders journal-worthy events into feed entries with deep links
 * (docs/spec/07-journal.md). OWNER: journal/notifications feature.
 */

export const JOURNAL_EVENT_TYPES = new Set([
  'journal.post',
  'location.stop.ended',
  'location.crossing.state',
  'trip.leg.arrived',
  'game.finished',
])

export interface JournalEntry {
  seq: number
  kind: 'post' | 'stop' | 'state_crossing' | 'leg_arrival' | 'game_result'
  ts: string
  actor?: { id: string; name: string; avatar: string; role: string }
  text: string
  link?: Record<string, unknown>
}

/** Renders one event row (optionally joined with profile columns p_*) or null if not journal-worthy (JRNL-004/005/006). */
export function renderJournalEntry(_row: any): JournalEntry | null {
  // Implemented in the journal feature.
  return null
}
