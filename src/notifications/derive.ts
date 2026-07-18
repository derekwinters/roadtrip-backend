import type { EventRow } from '../events/store.js'
import { renderJournalEntry, type DeepLink, type ProfileNames } from '../journal/render.js'

/**
 * Pure derivation of per-profile notification items from event rows
 * (docs/spec/09-sync-notifications.md, NOTIF-001..004). No push infrastructure:
 * clients poll this view and raise local notifications.
 */
export interface NotificationItem {
  seq: number
  kind: 'challenge_received' | 'journal_activity'
  text: string
  game_id?: string
  link?: DeepLink
}

export function deriveNotifications(
  events: EventRow[],
  forProfileId: string,
  profilesById?: ProfileNames,
): NotificationItem[] {
  const items: NotificationItem[] = []
  for (const ev of events) {
    const payload = ev.payload ?? {}

    // NOTIF-002 — a challenge notifies exactly the invited profile.
    if (ev.type === 'game.created' && payload.invited_profile_id === forProfileId) {
      items.push({
        seq: ev.seq,
        kind: 'challenge_received',
        text: `You were challenged to ${payload.game_type}`,
        game_id: payload.game_id,
      })
      continue
    }

    // NOTIF-003/004 — journal activity notifies everyone but the actor. Derived events
    // (crossings, arrivals, stops) are actorless, so they notify every profile.
    // Everything else (pings, moves, config/admin) never notifies (NOTIF-004).
    if (ev.actor_id === forProfileId) continue
    const entry = renderJournalEntry(ev, profilesById)
    if (!entry) continue // non-journal type or short stop
    const item: NotificationItem = { seq: ev.seq, kind: 'journal_activity', text: entry.text }
    if (ev.type === 'game.finished') item.game_id = payload.game_id
    if (entry.link) item.link = entry.link
    items.push(item)
  }
  return items
}
