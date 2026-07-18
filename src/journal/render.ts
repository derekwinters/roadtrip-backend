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

export type DeepLink =
  | { kind: 'game_replay'; game_id: string }
  | { kind: 'map_pin'; lat: number; lon: number }
  | { kind: 'checklist'; state_code: string }
  | { kind: 'leg_summary'; destination_id: string }

export interface JournalEntry {
  seq: number
  kind: 'post' | 'stop' | 'state_crossing' | 'leg_arrival' | 'game_result'
  ts: string
  actor?: { id: string; name: string; avatar: string; role: string }
  text: string
  link?: DeepLink
}

export type ProfileNames = Map<string, { name: string; avatar: string }>

const KIND_BY_TYPE: Record<string, JournalEntry['kind']> = {
  'journal.post': 'post',
  'location.stop.ended': 'stop',
  'location.crossing.state': 'state_crossing',
  'trip.leg.arrived': 'leg_arrival',
  'game.finished': 'game_result',
}

function toIso(ts: unknown): string {
  return ts instanceof Date ? ts.toISOString() : new Date(String(ts)).toISOString()
}

/**
 * Renders one event row (optionally joined with profile columns p_*) or null if not
 * journal-worthy (JRNL-004/005/006). Game-result names are resolved via `profilesById`
 * because the game.finished payload carries profile ids only (JRNL-006).
 */
export function renderJournalEntry(row: any, profilesById?: ProfileNames): JournalEntry | null {
  const kind = KIND_BY_TYPE[row.type]
  if (!kind) return null
  const payload = row.payload ?? {}
  // JRNL-004 — short stops are recorded but never surface in the feed.
  if (row.type === 'location.stop.ended' && payload.journal_worthy === false) return null

  const entry: JournalEntry = { seq: Number(row.seq), kind, ts: toIso(row.client_ts), text: '' }
  if (row.p_id) entry.actor = { id: row.p_id, name: row.p_name, avatar: row.p_avatar, role: row.p_role }

  const name = (id: unknown): string =>
    (typeof id === 'string' && profilesById?.get(id)?.name) || 'Someone'

  switch (kind) {
    case 'post':
      entry.text = String(payload.text ?? '')
      break // no deep link (JRNL-005)
    case 'stop': {
      const minutes = Math.round(Number(payload.duration_min ?? 0))
      entry.text = payload.place
        ? `Stopped for ${minutes} min near ${payload.place}`
        : `Stopped for ${minutes} min`
      entry.link = { kind: 'map_pin', lat: payload.lat, lon: payload.lon }
      break
    }
    case 'state_crossing':
      entry.text = `Crossed into ${payload.state}`
      entry.link = { kind: 'checklist', state_code: payload.state_code }
      break
    case 'leg_arrival': {
      const s = payload.summary ?? {}
      const wallH = (Number(s.wall_minutes ?? 0) / 60).toFixed(1)
      const movingH = (Number(s.moving_minutes ?? 0) / 60).toFixed(1)
      const miles = Math.round(Number(s.miles ?? 0))
      entry.text = `Arrived at ${payload.destination_name}. ${wallH} h in the car (${movingH} h driving), ${miles} mi, ${s.stop_count} stops.`
      entry.link = { kind: 'leg_summary', destination_id: payload.destination_id }
      break
    }
    case 'game_result': {
      // JRNL-006 — everything below comes from the game.finished payload + profile names.
      const game = payload.game_type ?? 'a game'
      const winner = name(payload.winner_profile_id)
      const loser = name(payload.loser_profile_id)
      if (payload.result === 'draw') {
        entry.text = `${winner} and ${loser} drew in ${game} after ${payload.move_count} moves`
      } else if (payload.resigned) {
        entry.text = `${winner} beat ${loser} in ${game} (resigned)`
      } else {
        entry.text = `${winner} beat ${loser} in ${game}, ${payload.move_count} moves`
      }
      entry.link = { kind: 'game_replay', game_id: payload.game_id }
      break
    }
  }
  return entry
}
