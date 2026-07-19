import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { migrate } from '../../src/db.js'

let t: TestApp
let parent: { id: string }
let kid: { id: string }

beforeAll(async () => {
  t = await createTestApp()
  parent = await t.addProfile('Dad', 'parent')
  kid = await t.addProfile('Sam', 'kid')
})
afterAll(async () =>
  await t.close())

const iso = (d = new Date()) => d.toISOString()

function batch(events: Array<{ type: string; payload: unknown; event_id?: string; client_ts?: string }>) {
  return {
    device_id: 'test-device',
    events: events.map((e) => ({
      event_id: e.event_id ?? randomUUID(),
      type: e.type,
      client_ts: e.client_ts ?? iso(),
      payload: e.payload,
    })),
  }
}

describe('system foundation', () => {
  it('serves health with version for connectivity checks [SYS-005]', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('migrations are idempotent across restarts [SYS-004]', async () => {
    const first = await migrate(t.db.pool)
    expect(first).toEqual([]) // already applied by the harness
    const second = await migrate(t.db.pool)
    expect(second).toEqual([])
  })

  it('serves timestamps as UTC ISO-8601 [SYS-006]', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(kid.id),
      payload: batch([{ type: 'journal.post', payload: { text: 'utc check' } }]),
    })
    const res = await t.app.inject({ method: 'GET', url: '/api/events', headers: asProfile(kid.id) })
    const ev = res.json().events.at(-1)
    expect(ev.client_ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    expect(ev.server_ts).toMatch(/Z$/)
  })
})

describe('profiles & permissions', () => {
  it('lists profiles unauthenticated as the login datasource [PRO-001]', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/profiles' })
    expect(res.statusCode).toBe(200)
    const names = res.json().map((p: any) => p.name)
    expect(names).toContain('Dad')
    expect(names).toContain('Sam')
  })

  it('parents can create profiles; kids only while creation is open [PRO-002] [PRO-007] [PRO-009]', async () => {
    // With open_profile_creation off, the strict parent-only rule applies.
    await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(parent.id),
      payload: { open_profile_creation: false },
    })
    const denied = await t.app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: asProfile(kid.id),
      payload: { name: 'Hacker', role: 'parent' },
    })
    expect(denied.statusCode).toBe(403)

    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: asProfile(parent.id),
      payload: { name: 'Mom', avatar: '🚗', role: 'parent' },
    })
    expect(ok.statusCode).toBe(201)

    const events = await t.app.inject({
      method: 'GET',
      url: '/api/events?types=profile.created',
      headers: asProfile(parent.id),
    })
    const created = events.json().events
    expect(created.some((e: any) => e.payload.name === 'Mom')).toBe(true)

    // Back to the default for the rest of the suite.
    const restore = await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(parent.id),
      payload: { open_profile_creation: true },
    })
    expect(restore.statusCode).toBe(200)
  })

  it('role changes take effect immediately on the next request [PRO-003]', async () => {
    const p = await t.addProfile('Flip', 'kid')
    const before = await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(p.id),
      payload: { stop_radius_m: 150 },
    })
    expect(before.statusCode).toBe(403)
    await t.db.pool.query(`UPDATE profiles SET role = 'parent' WHERE id = $1`, [p.id])
    const after = await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(p.id),
      payload: { stop_radius_m: 150 },
    })
    expect(after.statusCode).toBe(200)
    await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(parent.id),
      payload: { stop_radius_m: 100 },
    })
  })

  it('unknown or missing profile gets 401 with the error envelope [PRO-004] [API-001]', async () => {
    const missing = await t.app.inject({ method: 'GET', url: '/api/journal' })
    expect(missing.statusCode).toBe(401)
    expect(missing.json().error.code).toBe('unauthenticated')

    const unknown = await t.app.inject({
      method: 'GET',
      url: '/api/journal',
      headers: asProfile(randomUUID()),
    })
    expect(unknown.statusCode).toBe(401)
  })

  it('parent-only routes return parent_required for kids [PRO-005] [SYS-008]', async () => {
    // Profile CREATE is governed by PRO-009 (open by default); profile UPDATE stays
    // parent-only unconditionally.
    for (const [method, url, payload] of [
      ['POST', '/api/destinations', { name: 'X', lat: 1, lon: 1 }],
      ['PUT', '/api/config', { stop_radius_m: 120 }],
      ['PATCH', '/api/profiles/00000000-0000-0000-0000-000000000000', { name: 'X' }],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: asProfile(kid.id), payload })
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe('parent_required')
    }
  })
})

describe('event stream & sync', () => {
  it('replayed event_ids are duplicates and never re-stored [EVT-001] [SYS-001] [SYNC-002]', async () => {
    const eventId = randomUUID()
    const original = batch([
      { type: 'journal.post', payload: { text: 'first version' }, event_id: eventId },
    ])
    const res1 = await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(kid.id),
      payload: original,
    })
    expect(res1.json().results[0].status).toBe('accepted')
    const seq = res1.json().results[0].seq

    // Retry with the same id but different payload: reported duplicate, content unchanged.
    const retry = batch([
      { type: 'journal.post', payload: { text: 'tampered version' }, event_id: eventId },
    ])
    const res2 = await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(kid.id),
      payload: retry,
    })
    expect(res2.json().results[0]).toMatchObject({ status: 'duplicate', seq })

    const { rows } = await t.db.pool.query('SELECT payload FROM events WHERE event_id = $1', [eventId])
    expect(rows).toHaveLength(1)
    expect(rows[0].payload.text).toBe('first version')
  })

  it('seq is a gapless-forward cursor: paging by after never misses or repeats [EVT-002]', async () => {
    const ids = Array.from({ length: 5 }, () => randomUUID())
    await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(kid.id),
      payload: batch(ids.map((id, i) => ({ type: 'journal.post', payload: { text: `page ${i}` }, event_id: id }))),
    })
    const seen: number[] = []
    let after = 0
    for (;;) {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/events?after=${after}&limit=2`,
        headers: asProfile(kid.id),
      })
      const { events, next_after } = res.json()
      if (events.length === 0) break
      for (const e of events) seen.push(e.seq)
      after = next_after
    }
    const sorted = [...seen].sort((a, b) => a - b)
    expect(seen).toEqual(sorted)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('malformed payloads are rejected per event and not persisted [EVT-003] [SYNC-004]', async () => {
    const good = randomUUID()
    const bad = randomUUID()
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(parent.id),
      payload: batch([
        { type: 'location.ping', payload: { lat: 999, lon: 0 }, event_id: bad },
        { type: 'journal.post', payload: { text: 'valid entry' }, event_id: good },
      ]),
    })
    const results = res.json().results
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('accepted')
    const { rows } = await t.db.pool.query('SELECT 1 FROM events WHERE event_id = $1', [bad])
    expect(rows).toHaveLength(0)
  })

  it('server-derived types cannot be uploaded by clients [EVT-004]', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(parent.id),
      payload: batch([
        {
          type: 'trip.leg.arrived',
          payload: { destination_id: randomUUID(), destination_name: 'Fake', summary: { wall_minutes: 0, moving_minutes: 0, miles: 0, stop_count: 0, states: [], games_played: 0 } },
        },
      ]),
    })
    expect(res.json().results[0]).toMatchObject({ status: 'rejected', reason: 'forbidden_type' })
  })

  it('kid profiles cannot upload pings [EVT-005]', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(kid.id),
      payload: batch([{ type: 'location.ping', payload: { lat: 40, lon: -105 } }]),
    })
    expect(res.json().results[0]).toMatchObject({ status: 'rejected', reason: 'not_parent' })
  })

  it('client_ts is preserved verbatim; server_ts is independent [EVT-006] [SYNC-003]', async () => {
    const when = '2026-07-01T09:30:00.000Z'
    const id = randomUUID()
    await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(kid.id),
      payload: batch([{ type: 'journal.post', payload: { text: 'backdated' }, event_id: id, client_ts: when }]),
    })
    const { rows } = await t.db.pool.query('SELECT client_ts, server_ts FROM events WHERE event_id = $1', [id])
    expect(rows[0].client_ts.toISOString()).toBe(when)
    expect(rows[0].server_ts.toISOString()).not.toBe(when)
  })

  it('feed filters by types and pages with next_after [EVT-007]', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/events?types=journal.post&limit=3',
      headers: asProfile(kid.id),
    })
    const { events } = res.json()
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e: any) => e.type === 'journal.post')).toBe(true)
  })

  it('long-poll wakes when an event is committed [EVT-008]', async () => {
    const cur = await t.app.inject({ method: 'GET', url: '/api/events?limit=500', headers: asProfile(kid.id) })
    let after = cur.json().next_after
    for (;;) {
      const page = await t.app.inject({
        method: 'GET',
        url: `/api/events?after=${after}&limit=500`,
        headers: asProfile(kid.id),
      })
      if (page.json().events.length === 0) break
      after = page.json().next_after
    }

    const waiter = t.app.inject({
      method: 'GET',
      url: `/api/events?after=${after}&wait=10`,
      headers: asProfile(kid.id),
    })
    const started = Date.now()
    setTimeout(() => {
      void t.app.inject({
        method: 'POST',
        url: '/api/journal',
        headers: asProfile(kid.id),
        payload: { text: 'wake up!' },
      })
    }, 300)
    const res = await waiter
    expect(Date.now() - started).toBeLessThan(8000)
    expect(res.json().events.some((e: any) => e.payload?.text === 'wake up!')).toBe(true)
  })

  it('processes whole batches with mixed outcomes in input order [SYNC-001]', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(kid.id),
      payload: batch([
        { type: 'journal.post', payload: { text: 'ok 1' }, event_id: ids[0] },
        { type: 'game.move', payload: {}, event_id: ids[1] },
        { type: 'journal.post', payload: { text: 'ok 2' }, event_id: ids[2] },
      ]),
    })
    const results = res.json().results
    expect(results.map((r: any) => r.event_id)).toEqual(ids)
    expect(results.map((r: any) => r.status)).toEqual(['accepted', 'rejected', 'accepted'])
  })
})

describe('config', () => {
  it('exposes all keys with defaults seeded on first boot [CFG-001] [CFG-005]', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/config', headers: asProfile(kid.id) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      ping_interval_s: 300,
      stop_radius_m: 100,
      min_stop_duration_min: 10,
      arrival_radius_m: 800,
      city_radius_km: 10,
      open_profile_creation: true, // covers: CFG-006
    })
  })

  it('open_profile_creation is boolean-validated and parent-togglable [CFG-006] [CFG-002]', async () => {
    // Non-boolean values are rejected without applying anything.
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(parent.id),
      payload: { open_profile_creation: 42 },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('validation')

    const off = await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(parent.id),
      payload: { open_profile_creation: false },
    })
    expect(off.statusCode).toBe(200)
    expect(off.json().open_profile_creation).toBe(false)

    const read = await t.app.inject({ method: 'GET', url: '/api/config', headers: asProfile(kid.id) })
    expect(read.json().open_profile_creation).toBe(false)

    // Back to the default so the rest of the suite sees open creation.
    const on = await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(parent.id),
      payload: { open_profile_creation: true },
    })
    expect(on.json().open_profile_creation).toBe(true)
  })

  it('rejects unknown keys and out-of-bounds values atomically [CFG-002] [API-002]', async () => {
    const unknown = await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(parent.id),
      payload: { flux_capacitor: 88 },
    })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().error.code).toBe('validation')

    const partial = await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(parent.id),
      payload: { stop_radius_m: 200, arrival_radius_m: 99999 },
    })
    expect(partial.statusCode).toBe(400)
    const after = await t.app.inject({ method: 'GET', url: '/api/config', headers: asProfile(kid.id) })
    expect(after.json().stop_radius_m).toBe(100) // nothing applied
  })

  it('updates emit config.updated with exactly the changed keys [CFG-003]', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(parent.id),
      payload: { min_stop_duration_min: 12 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().min_stop_duration_min).toBe(12)

    const events = await t.app.inject({
      method: 'GET',
      url: '/api/events?types=config.updated',
      headers: asProfile(parent.id),
    })
    const last = events.json().events.at(-1)
    expect(last.payload.changes).toEqual({ min_stop_duration_min: 12 })
    await t.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: asProfile(parent.id),
      payload: { min_stop_duration_min: 10 },
    })
  })
})

describe('api conventions', () => {
  it('unknown /api routes return the envelope, not the framework default [API-004]', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nonsense', headers: asProfile(kid.id) })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })
})
