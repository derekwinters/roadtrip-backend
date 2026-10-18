import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { offsetMeters, type LatLon } from '../../src/location/geo.js'

/**
 * Stop labels (docs/spec/06-location.md LOC-014..017, 07-journal.md LIST-001/003,
 * 05-config.md CFG-008): a parent names any stop through a client-uploaded
 * `location.stop.labeled {stop_id, label}` event.
 */

const T0 = Date.parse('2026-07-02T09:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

const LOVELAND_I25 = { lat: 40.4, lon: -104.99 }
const off = (northM: number) => offsetMeters(LOVELAND_I25, northM, 0)

async function sync(t: TestApp, profileId: string, events: Array<{ type: string; client_ts: string; payload: unknown }>) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sync/batch',
    headers: asProfile(profileId),
    payload: { events: events.map((e) => ({ event_id: randomUUID(), ...e })) },
  })
  expect(res.statusCode).toBe(200)
  return res.json().results as Array<{ status: string; reason?: string; seq?: number }>
}

const ping = (pt: LatLon, min: number) => ({ type: 'location.ping', client_ts: at(min), payload: { lat: pt.lat, lon: pt.lon } })
const label = (stopId: string, text: string, min: number) => ({
  type: 'location.stop.labeled',
  client_ts: at(min),
  payload: { stop_id: stopId, label: text },
})

describe('stop labels', () => {
  let t: TestApp
  let parent: { id: string }
  let kid: { id: string }
  // A: 15-min journal-worthy (place Loveland); B, C: 5-min short stops; D: 15-min journal-worthy; E: still open.
  let A: string, B: string, C: string, D: string, E: string

  const labelEvents = async () =>
    (
      await t.db.pool.query(
        `SELECT payload, client_ts, actor_id FROM events WHERE type = 'location.stop.labeled' ORDER BY seq`,
      )
    ).rows
  const checklistStops = async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/checklist', headers: asProfile(kid.id) })
    expect(res.statusCode).toBe(200)
    return res.json().stops as Array<Record<string, unknown>>
  }

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
    kid = await t.addProfile('Sam', 'kid')
    const results = await sync(t, parent.id, [
      ping(LOVELAND_I25, 0),
      ping(LOVELAND_I25, 5),
      ping(LOVELAND_I25, 12),
      ping(off(4000), 15), // A closes: 15 min
      ping(off(9000), 20),
      ping(off(9000), 24),
      ping(off(13000), 25), // B closes: 5 min
      ping(off(13000), 29),
      ping(off(18000), 30), // C closes: 5 min
      ping(off(30000), 40),
      ping(off(30000), 45),
      ping(off(30000), 52),
      ping(off(35000), 55), // D closes: 15 min
      ping(off(40000), 61),
      ping(off(40000), 65), // E opens, stays open
    ])
    for (const r of results) expect(r.status).toBe('accepted')
    const { rows } = await t.db.pool.query('SELECT id, journal_worthy, ended_at FROM stops ORDER BY started_at')
    expect(rows.map((r: any) => r.journal_worthy)).toEqual([true, false, false, true, null])
    ;[A, B, C, D, E] = rows.map((r: any) => r.id)
  })
  afterAll(async () => await t.close())

  it('accepts a parent label through sync and stores it with its client_ts [LOC-014]', async () => {
    const [r] = await sync(t, parent.id, [label(A, 'Gas & snacks', 100)])
    expect(r!.status).toBe('accepted')
    const stored = await labelEvents()
    expect(stored).toHaveLength(1)
    expect(stored[0].payload).toEqual({ stop_id: A, label: 'Gas & snacks' })
    expect(new Date(stored[0].client_ts).toISOString()).toBe(at(100))
    expect(stored[0].actor_id).toBe(parent.id)
  })

  it('rejects a kid profile label per-event with not_parent and stores nothing [LOC-014]', async () => {
    const before = (await labelEvents()).length
    const [r] = await sync(t, kid.id, [label(A, 'Kid name', 101)])
    expect(r).toMatchObject({ status: 'rejected', reason: 'not_parent' })
    expect(await labelEvents()).toHaveLength(before)
  })

  it('trims the label, rejects blank and over-length labels without persisting them [LOC-015]', async () => {
    const before = (await labelEvents()).length
    const results = await sync(t, parent.id, [
      label(D, '   ', 102),
      label(D, 'x'.repeat(81), 103), // default stop_label_max_chars = 80
      label(D, `  ${'y'.repeat(80)}  `, 104), // 80 after trimming: accepted
    ])
    expect(results[0]).toMatchObject({ status: 'rejected', reason: 'label must not be blank' })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: 'label_too_long' })
    expect(results[2]!.status).toBe('accepted')
    const stored = await labelEvents()
    expect(stored).toHaveLength(before + 1)
    expect(stored[stored.length - 1].payload.label).toBe('y'.repeat(80))
  })

  it('takes the length cap from runtime config, applying a change to the next batch [CFG-008] [LOC-015]', async () => {
    const get = await t.app.inject({ method: 'GET', url: '/api/config', headers: asProfile(kid.id) })
    expect(get.json().stop_label_max_chars).toBe(80)

    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(parent.id),
      payload: { stop_label_max_chars: 2001 },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('validation')
    const frac = await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(parent.id),
      payload: { stop_label_max_chars: 5.5 },
    })
    expect(frac.statusCode).toBe(400)
    const kidPut = await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(kid.id),
      payload: { stop_label_max_chars: 5 },
    })
    expect(kidPut.statusCode).toBe(403)

    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(parent.id),
      payload: { stop_label_max_chars: 5 },
    })
    expect(put.statusCode).toBe(200)
    try {
      const results = await sync(t, parent.id, [label(D, 'Lunch!', 105), label(D, ' Lunch ', 106)])
      expect(results[0]).toMatchObject({ status: 'rejected', reason: 'label_too_long' })
      expect(results[1]!.status).toBe('accepted')
    } finally {
      const reset = await t.app.inject({
        method: 'PUT',
        url: '/api/config',
        headers: asProfile(parent.id),
        payload: { stop_label_max_chars: 80 },
      })
      expect(reset.statusCode).toBe(200)
    }
  })

  it('rejects a label for an unknown stop_id with unknown_stop and stores nothing [LOC-016]', async () => {
    const before = (await labelEvents()).length
    const [r] = await sync(t, parent.id, [label(randomUUID(), 'Nowhere', 107)])
    expect(r).toMatchObject({ status: 'rejected', reason: 'unknown_stop' })
    expect(await labelEvents()).toHaveLength(before)
  })

  it('shows the label next to the unchanged place in the checklist [LOC-017] [LIST-003]', async () => {
    const stops = await checklistStops()
    const a = stops.find((s) => s.stop_id === A)!
    expect(a).toMatchObject({ stop_id: A, place: 'Loveland', label: 'Gas & snacks', started_at: at(0), duration_min: 15 })
  })

  it('re-labeling is last-write-wins by client_ts, not by upload order [LOC-017]', async () => {
    expect((await sync(t, parent.id, [label(A, "Grandma's", 200)]))[0]!.status).toBe('accepted')
    expect((await checklistStops()).find((s) => s.stop_id === A)!.label).toBe("Grandma's")

    // A label written earlier (offline) but synced later never overwrites the newer one.
    expect((await sync(t, parent.id, [label(A, 'Old name', 150)]))[0]!.status).toBe('accepted')
    expect((await checklistStops()).find((s) => s.stop_id === A)!.label).toBe("Grandma's")
  })

  it('a never-labeled stop reads back exactly as before, with no label field [LOC-017] [LIST-001]', async () => {
    // D is labeled above (labels are append-only), so check the never-labeled shape on a fresh app.
    const fresh = await createTestApp()
    try {
      const dad = await fresh.addProfile('Dad', 'parent')
      await sync(fresh, dad.id, [ping(LOVELAND_I25, 0), ping(LOVELAND_I25, 5), ping(LOVELAND_I25, 12), ping(off(4000), 15)])
      const res = await fresh.app.inject({ method: 'GET', url: '/api/checklist', headers: asProfile(dad.id) })
      const [stop] = res.json().stops
      expect(Object.keys(stop).sort()).toEqual(['duration_min', 'lat', 'lon', 'place', 'started_at', 'stop_id'])
      expect(stop).toMatchObject({ place: 'Loveland', started_at: at(0), duration_min: 15 })
    } finally {
      await fresh.close()
    }
  })

  it('a labeled short stop appears in the checklist; an unlabeled one does not [LIST-003] [LIST-001]', async () => {
    expect((await sync(t, parent.id, [label(B, 'Rest area', 300)]))[0]!.status).toBe('accepted')
    const stops = await checklistStops()
    expect(stops.map((s) => s.stop_id)).toEqual([A, B, D]) // C (short, unlabeled) excluded; ordered by started_at
    const b = stops.find((s) => s.stop_id === B)!
    expect(b).toMatchObject({ label: 'Rest area', place: null, started_at: at(20), duration_min: 5 })
    expect(stops.find((s) => s.stop_id === C)).toBeUndefined()
  })

  it('a labeled short stop stays out of the journal and summary stop counts [LIST-003]', async () => {
    const journal = await t.app.inject({ method: 'GET', url: '/api/journal?limit=100', headers: asProfile(kid.id) })
    const stopEntries = journal.json().entries.filter((e: any) => e.kind === 'stop')
    expect(stopEntries).toHaveLength(2) // A and D only
    const summary = await t.app.inject({ method: 'GET', url: '/api/trip/summary', headers: asProfile(kid.id) })
    expect(summary.json().stop_count).toBe(2)
  })

  it('accepts a label on a stop that is still open, listing it only once it ends [LOC-016] [LIST-003]', async () => {
    expect((await sync(t, parent.id, [label(E, 'Parked', 400)]))[0]!.status).toBe('accepted')
    expect((await checklistStops()).find((s) => s.stop_id === E)).toBeUndefined()
    await sync(t, parent.id, [ping(off(45000), 70)]) // E closes: 9 min, short
    const e = (await checklistStops()).find((s) => s.stop_id === E)!
    expect(e).toMatchObject({ label: 'Parked', duration_min: 9 })
  })
})
