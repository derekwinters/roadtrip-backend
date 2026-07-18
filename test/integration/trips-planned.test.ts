import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'

/**
 * Planned trips (docs/spec/12-trips.md, TRIP-013..017): staging the next road trip —
 * planned status, staged destinations, activation adoption, informational
 * planned_start_at, and deletion.
 */

async function getJson(t: TestApp, profileId: string, url: string) {
  const res = await t.app.inject({ method: 'GET', url, headers: asProfile(profileId) })
  expect(res.statusCode).toBe(200)
  return res.json()
}

/** Syncs one journal.post with an explicit client_ts. */
async function syncPost(t: TestApp, profileId: string, text: string, clientTs: string) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sync/batch',
    headers: asProfile(profileId),
    payload: {
      device_id: 'planned-test',
      events: [{ event_id: randomUUID(), type: 'journal.post', client_ts: clientTs, payload: { text } }],
    },
  })
  expect(res.statusCode).toBe(200)
  expect(res.json().results[0].status).toBe('accepted')
}

describe('planned trips', () => {
  let t: TestApp
  let parent: { id: string }
  let kid: { id: string }
  let planned: any
  let detour: any
  let zion: any
  let bryce: any

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
    kid = await t.addProfile('Sam', 'kid')
  })
  afterAll(async () => await t.close())

  const startTrip = (profileId: string, payload: Record<string, unknown>) =>
    t.app.inject({ method: 'POST', url: '/api/trips', headers: asProfile(profileId), payload })

  it('creates a planned trip: parent-only, no window, at most one planned [TRIP-013]', async () => {
    const denied = await startTrip(kid.id, { status: 'planned', name: 'Kid Plan' })
    expect(denied.statusCode).toBe(403)

    // planned_start_at is only meaningful for planned trips.
    const invalid = await startTrip(parent.id, { planned_start_at: '2027-03-14T09:00:00.000Z' })
    expect(invalid.statusCode).toBe(400)

    // planned_start_at deliberately in the past: nothing may auto-activate (TRIP-016).
    const res = await startTrip(parent.id, {
      name: 'Spring Break',
      status: 'planned',
      planned_start_at: '2020-03-14T09:00:00.000Z',
    })
    expect(res.statusCode).toBe(201)
    planned = res.json()
    expect(planned.status).toBe('planned')
    expect(planned.started_at).toBeNull()
    expect(planned.ended_at).toBeNull()
    expect(planned.planned_start_at).toBe('2020-03-14T09:00:00.000Z')

    const second = await startTrip(parent.id, { status: 'planned', name: 'Second Plan' })
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('conflict')

    const list = await getJson(t, kid.id, '/api/trips')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: planned.id, status: 'planned', started_at: null })
  })

  it('planned trips never associate events and are never the default read scope [TRIP-013]', async () => {
    // Only the planned trip exists: events stay unassociated and reads stay unscoped.
    await syncPost(t, kid.id, 'while planning', new Date().toISOString())
    let events = (await getJson(t, kid.id, '/api/events?types=journal.post')).events
    const whilePlanning = events.find((e: any) => e.payload.text === 'while planning')
    expect(whilePlanning.trip_id).toBeNull()
    const journal = await getJson(t, kid.id, '/api/journal')
    expect(journal.entries.map((e: any) => e.text)).toContain('while planning')

    // With an active trip alongside, events associate with the ACTIVE trip, never the plan.
    const res = await startTrip(parent.id, { name: 'Detour' })
    expect(res.statusCode).toBe(201) // planning does not block starting a trip directly
    detour = res.json()
    await syncPost(t, kid.id, 'during detour', new Date().toISOString())
    events = (await getJson(t, kid.id, '/api/events?types=journal.post')).events
    const duringDetour = events.find((e: any) => e.payload.text === 'during detour')
    expect(duringDetour.trip_id).toBe(detour.id)

    const ended = await t.app.inject({
      method: 'POST',
      url: `/api/trips/${detour.id}/end`,
      headers: asProfile(parent.id),
    })
    expect(ended.statusCode).toBe(200)
    detour = ended.json()
  })

  it('stages destinations against the planned trip via ?trip [TRIP-014]', async () => {
    const denied = await t.app.inject({
      method: 'POST',
      url: `/api/destinations?trip=${planned.id}`,
      headers: asProfile(kid.id),
      payload: { name: 'Kid Stop', lat: 37, lon: -113 },
    })
    expect(denied.statusCode).toBe(403)

    const addStaged = async (name: string) => {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/destinations?trip=${planned.id}`,
        headers: asProfile(parent.id),
        payload: { name, lat: 37.2, lon: -112.98 },
      })
      expect(res.statusCode).toBe(201)
      return res.json()
    }
    zion = await addStaged('Zion Lodge')
    bryce = await addStaged('Bryce Point')

    const staged = await getJson(t, parent.id, `/api/destinations?trip=${planned.id}`)
    expect(staged.map((d: any) => [d.name, d.status])).toEqual([
      ['Zion Lodge', 'pending'],
      ['Bryce Point', 'pending'],
    ])
    // The staged list never leaks into the default pool (no active trip -> NULL pool).
    expect(await getJson(t, parent.id, '/api/destinations')).toEqual([])
    // The ended trip's list is readable too, and it is empty.
    expect(await getJson(t, parent.id, `/api/destinations?trip=${detour.id}`)).toEqual([])

    // Unknown trips are 404; staging against a non-planned trip is 409.
    const unknownList = await t.app.inject({
      method: 'GET',
      url: `/api/destinations?trip=${randomUUID()}`,
      headers: asProfile(parent.id),
    })
    expect(unknownList.statusCode).toBe(404)
    const unknownWrite = await t.app.inject({
      method: 'POST',
      url: `/api/destinations?trip=${randomUUID()}`,
      headers: asProfile(parent.id),
      payload: { name: 'Ghost', lat: 37, lon: -113 },
    })
    expect(unknownWrite.statusCode).toBe(404)
    const notPlanned = await t.app.inject({
      method: 'POST',
      url: `/api/destinations?trip=${detour.id}`,
      headers: asProfile(parent.id),
      payload: { name: 'Too Late', lat: 37, lon: -113 },
    })
    expect(notPlanned.statusCode).toBe(409)
    expect(notPlanned.json().error.code).toBe('conflict')

    // PATCH/DELETE with ?trip require the destination to belong to that trip.
    const renamed = await t.app.inject({
      method: 'PATCH',
      url: `/api/destinations/${zion.id}?trip=${planned.id}`,
      headers: asProfile(parent.id),
      payload: { name: 'Zion Lodge East' },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().name).toBe('Zion Lodge East')
    const wrongTrip = await t.app.inject({
      method: 'PATCH',
      url: `/api/destinations/${zion.id}?trip=${detour.id}`,
      headers: asProfile(parent.id),
      payload: { name: 'Nope' },
    })
    expect(wrongTrip.statusCode).toBe(404)
    const wrongDelete = await t.app.inject({
      method: 'DELETE',
      url: `/api/destinations/${bryce.id}?trip=${detour.id}`,
      headers: asProfile(parent.id),
    })
    expect(wrongDelete.statusCode).toBe(404)
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/destinations/${bryce.id}?trip=${planned.id}`,
      headers: asProfile(parent.id),
    })
    expect(del.statusCode).toBe(204)
    bryce = await addStaged('Bryce Point')
    const after = await getJson(t, parent.id, `/api/destinations?trip=${planned.id}`)
    expect(after.map((d: any) => d.name)).toEqual(['Zion Lodge East', 'Bryce Point'])
  })

  it('planned_start_at is informational only and PATCHable while planned [TRIP-016]', async () => {
    // Created with a planned_start_at long in the past — still planned (no auto-activation).
    const list = await getJson(t, kid.id, '/api/trips')
    const row = list.find((x: any) => x.id === planned.id)
    expect(row.status).toBe('planned')
    expect(row.planned_start_at).toBe('2020-03-14T09:00:00.000Z')

    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/api/trips/${planned.id}`,
      headers: asProfile(parent.id),
      payload: { planned_start_at: '2030-07-04T14:00:00.000Z' },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().planned_start_at).toBe('2030-07-04T14:00:00.000Z')
    expect(patched.json().status).toBe('planned')

    const renamed = await t.app.inject({
      method: 'PATCH',
      url: `/api/trips/${planned.id}`,
      headers: asProfile(parent.id),
      payload: { name: 'Spring Break II' },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().name).toBe('Spring Break II')
    expect(renamed.json().planned_start_at).toBe('2030-07-04T14:00:00.000Z')
  })

  it('activation adopts the staged destinations and opens the window [TRIP-015]', async () => {
    const start = (profileId: string, id: string) =>
      t.app.inject({ method: 'POST', url: `/api/trips/${id}/start`, headers: asProfile(profileId) })

    expect((await start(kid.id, planned.id)).statusCode).toBe(403)
    expect((await start(parent.id, detour.id)).statusCode).toBe(409) // ended, not planned
    expect((await start(parent.id, randomUUID())).statusCode).toBe(404)

    // Another active trip blocks activation.
    const blocker = (await startTrip(parent.id, { name: 'Blocker' })).json()
    const blocked = await start(parent.id, planned.id)
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error.code).toBe('conflict')
    await t.app.inject({ method: 'POST', url: `/api/trips/${blocker.id}/end`, headers: asProfile(parent.id) })

    const res = await start(parent.id, planned.id)
    expect(res.statusCode).toBe(200)
    const activated = res.json()
    expect(activated.status).toBe('active')
    expect(typeof activated.started_at).toBe('string')
    expect(activated.planned_start_at).toBe('2030-07-04T14:00:00.000Z') // retained, informational

    // trip.started is emitted at activation and associates with its own fresh window.
    const events = (await getJson(t, parent.id, '/api/events?types=trip.started')).events
    const startedEv = events.find((e: any) => e.payload.trip_id === planned.id)
    expect(startedEv.payload).toEqual({ trip_id: planned.id, name: 'Spring Break II' })
    expect(startedEv.client_ts).toBe(activated.started_at)
    expect(startedEv.trip_id).toBe(planned.id)

    // The staged destinations are now the active trip's list; the first is reconciled active.
    const dests = await getJson(t, parent.id, '/api/destinations')
    expect(dests.map((d: any) => [d.name, d.status])).toEqual([
      ['Zion Lodge East', 'active'],
      ['Bryce Point', 'pending'],
    ])

    expect((await start(parent.id, planned.id)).statusCode).toBe(409) // no longer planned

    // TRIP-016: planned_start_at is immutable once the trip is no longer planned.
    const lateSchedule = await t.app.inject({
      method: 'PATCH',
      url: `/api/trips/${planned.id}`,
      headers: asProfile(parent.id),
      payload: { planned_start_at: '2031-01-01T00:00:00.000Z' },
    })
    expect(lateSchedule.statusCode).toBe(409)
    const rename = await t.app.inject({
      method: 'PATCH',
      url: `/api/trips/${planned.id}`,
      headers: asProfile(parent.id),
      payload: { name: 'Spring Break Final' },
    })
    expect(rename.statusCode).toBe(200) // renaming any trip stays allowed (TRIP-003)
  })

  it('deletes a planned trip together with its staged destinations [TRIP-017]', async () => {
    // The previous plan is active now, so a new plan slot is free.
    const next = (await startTrip(parent.id, { status: 'planned', name: 'Next Summer' })).json()
    const staged = await t.app.inject({
      method: 'POST',
      url: `/api/destinations?trip=${next.id}`,
      headers: asProfile(parent.id),
      payload: { name: 'Moab', lat: 38.57, lon: -109.55 },
    })
    expect(staged.statusCode).toBe(201)

    const del = (profileId: string, id: string) =>
      t.app.inject({ method: 'DELETE', url: `/api/trips/${id}`, headers: asProfile(profileId) })

    expect((await del(kid.id, next.id)).statusCode).toBe(403)
    expect((await del(parent.id, planned.id)).statusCode).toBe(409) // active
    expect((await del(parent.id, detour.id)).statusCode).toBe(409) // ended
    expect((await del(parent.id, randomUUID())).statusCode).toBe(404)

    expect((await del(parent.id, next.id)).statusCode).toBe(204)
    const list = await getJson(t, parent.id, '/api/trips')
    expect(list.map((x: any) => x.id)).not.toContain(next.id)
    const { rows } = await t.db.pool.query('SELECT 1 FROM destinations WHERE trip_id = $1', [next.id])
    expect(rows).toHaveLength(0)
    expect((await del(parent.id, next.id)).statusCode).toBe(404)
  })
})
