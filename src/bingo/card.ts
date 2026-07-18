/**
 * License Plate Bingo card (docs/spec/14-bingo.md): a pure fold over the trip's
 * plate.spotted / plate.unspotted events in client_ts order (BNG-002/003).
 * No side tables — the events stream is the system of record.
 */

export interface PlateEvent {
  seq: number
  type: string
  actor_id: string | null
  payload: any
  client_ts: string | Date
}

export interface BingoProfile {
  name: string
  role: string
}

export interface BingoCell {
  state_code: string
  /** Standing credit: the earliest spotter since the cell was last empty (BNG-002). */
  spotted_by: string | null
  spotted_by_name?: string
  spotted_at: string
}

export interface BingoLogItem {
  seq: number
  action: 'spotted' | 'unspotted'
  state_code: string
  actor_id: string | null
  actor_name?: string
  ts: string
}

export interface BingoCard {
  cells: BingoCell[]
  /** Effective actions only — no-ops and ignored removals are omitted (BNG-004). */
  log: BingoLogItem[]
  /** Standing cells per profile (BNG-004). */
  counts: Record<string, number>
}

const toIso = (ts: string | Date): string => (ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString())

/**
 * Folds plate.* events into the card. Ordering is client_ts (seq as tie-break), so
 * offline-queued events land where they happened (BNG-002). Duplicate spots and unspots
 * of empty states are no-ops; removals are honored only from the cell's original spotter
 * or a parent (BNG-003 — roles come from `profilesById`, which also supplies display
 * names when given).
 */
export function foldBingoCard(events: PlateEvent[], profilesById?: Map<string, BingoProfile>): BingoCard {
  const ordered = events
    .filter((e) => e.type === 'plate.spotted' || e.type === 'plate.unspotted')
    // seq arrives as a string from pg (BIGSERIAL) — normalize like the event store does.
    .map((e) => ({ ...e, seq: Number(e.seq), tsIso: toIso(e.client_ts) }))
    .sort((a, b) => {
      const d = Date.parse(a.tsIso) - Date.parse(b.tsIso)
      return d !== 0 ? d : a.seq - b.seq
    })

  const nameOf = (id: string | null): string | undefined =>
    id === null ? undefined : profilesById?.get(id)?.name

  const cells = new Map<string, BingoCell>()
  const log: BingoLogItem[] = []
  const logItem = (ev: (typeof ordered)[number], action: 'spotted' | 'unspotted', code: string): BingoLogItem => {
    const item: BingoLogItem = { seq: ev.seq, action, state_code: code, actor_id: ev.actor_id, ts: ev.tsIso }
    const name = nameOf(ev.actor_id)
    if (name !== undefined) item.actor_name = name
    return item
  }

  for (const ev of ordered) {
    const code = String(ev.payload?.state_code ?? '')
    const standing = cells.get(code)
    if (ev.type === 'plate.spotted') {
      if (standing) continue // duplicate spot: the first standing spotter keeps the credit
      const cell: BingoCell = { state_code: code, spotted_by: ev.actor_id, spotted_at: ev.tsIso }
      const name = nameOf(ev.actor_id)
      if (name !== undefined) cell.spotted_by_name = name
      cells.set(code, cell)
      log.push(logItem(ev, 'spotted', code))
    } else {
      if (!standing) continue // unspot of an empty state: no-op
      const isSpotter = ev.actor_id !== null && ev.actor_id === standing.spotted_by
      const isParent = ev.actor_id !== null && profilesById?.get(ev.actor_id)?.role === 'parent'
      if (!isSpotter && !isParent) continue // BNG-003: ignored (the event stays stored)
      cells.delete(code)
      log.push(logItem(ev, 'unspotted', code))
    }
  }

  const counts: Record<string, number> = {}
  for (const cell of cells.values()) {
    if (cell.spotted_by !== null) counts[cell.spotted_by] = (counts[cell.spotted_by] ?? 0) + 1
  }
  return {
    cells: [...cells.values()].sort((a, b) => a.state_code.localeCompare(b.state_code)),
    log,
    counts,
  }
}
