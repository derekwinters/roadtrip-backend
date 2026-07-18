import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'

/**
 * BNG-006 scenario: two API-driven trips keep fully disjoint bingo cards, and a spot
 * synced between trips belongs to neither. Real wall-clock trip windows, real sync path.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('bingo per-trip isolation', () => {
  let t: TestApp
  let parent: { id: string }
  let sam: { id: string }
  let alex: { id: string }
  let tripA: any
  let tripB: any

  const syncPlate = async (profileId: string, type: string, stateCode: string) => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(profileId),
      payload: {
        device_id: 'bingo-scenario',
        events: [
          {
            event_id: randomUUID(),
            type,
            client_ts: new Date().toISOString(),
            payload: { state_code: stateCode },
          },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().results[0].status).toBe('accepted')
  }

  const getJson = async (url: string) => {
    const res = await t.app.inject({ method: 'GET', url, headers: asProfile(parent.id) })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Dad', 'parent')
    sam = await t.addProfile('Sam', 'kid')
    alex = await t.addProfile('Alex', 'kid')

    // Trip A: two spots inside its window.
    tripA = (
      await t.app.inject({
        method: 'POST',
        url: '/api/trips',
        headers: asProfile(parent.id),
        payload: { name: 'Plates East' },
      })
    ).json()
    await sleep(20)
    await syncPlate(sam.id, 'plate.spotted', 'CO')
    await syncPlate(alex.id, 'plate.spotted', 'WY')
    await sleep(30)
    await t.app.inject({ method: 'POST', url: `/api/trips/${tripA.id}/end`, headers: asProfile(parent.id) })

    // Between trips: this spot lands in no trip at all (TRIP-010 semantics).
    await sleep(20)
    await syncPlate(sam.id, 'plate.spotted', 'KS')
    await sleep(20)

    // Trip B: a fresh card — TX spotted, NM spotted then withdrawn by its own spotter.
    tripB = (
      await t.app.inject({
        method: 'POST',
        url: '/api/trips',
        headers: asProfile(parent.id),
        payload: { name: 'Plates West' },
      })
    ).json()
    await sleep(20)
    await syncPlate(alex.id, 'plate.spotted', 'TX')
    await syncPlate(sam.id, 'plate.spotted', 'NM')
    await syncPlate(sam.id, 'plate.unspotted', 'NM')
  }, 60_000)
  afterAll(async () => await t.close())

  it('two trips keep disjoint cards; between-trip spots belong to neither [BNG-006]', async () => {
    const cardA = await getJson(`/api/bingo?trip=${tripA.id}`)
    expect(cardA.cells.map((c: any) => [c.state_code, c.spotted_by])).toEqual([
      ['CO', sam.id],
      ['WY', alex.id],
    ])
    expect(cardA.counts).toEqual({ [sam.id]: 1, [alex.id]: 1 })
    expect(cardA.log).toHaveLength(2)

    const cardB = await getJson(`/api/bingo?trip=${tripB.id}`)
    expect(cardB.cells.map((c: any) => [c.state_code, c.spotted_by])).toEqual([['TX', alex.id]])
    expect(cardB.counts).toEqual({ [alex.id]: 1 })
    // Trip B's log shows the withdrawn New Mexico sighting; trip A's does not know it.
    expect(cardB.log.map((l: any) => [l.action, l.state_code])).toEqual([
      ['spotted', 'TX'],
      ['spotted', 'NM'],
      ['unspotted', 'NM'],
    ])

    // Default scope follows the active trip (B).
    expect(await getJson('/api/bingo')).toEqual(cardB)

    // The Kansas spot between trips is stored but appears on neither card.
    expect(cardA.cells.map((c: any) => c.state_code)).not.toContain('KS')
    expect(cardB.cells.map((c: any) => c.state_code)).not.toContain('KS')
    const events = (await getJson('/api/events?types=plate.spotted')).events
    const ks = events.find((e: any) => e.payload.state_code === 'KS')
    expect(ks.trip_id).toBeNull()
  })
})
