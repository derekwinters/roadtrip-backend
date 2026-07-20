import { describe, it, expect, afterAll } from 'vitest'
import { createTestApp, asProfile } from '../helpers/app.js'
import { toClientEvents } from '../../scripts/simulate-trip.js'

const opened: any[] = []
afterAll(async () => {
  for (const h of opened) await h.close()
})

const START = Date.parse('2026-07-05T12:00:00.000Z')
const at = (s: number) => new Date(START + s * 1000).toISOString()

async function sync(t: any, parentId: string, pings: { lat: number; lon: number; ts: string }[]) {
  const events = toClientEvents(pings as any)
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sync/batch',
    headers: asProfile(parentId),
    payload: { device_id: 'sim', events },
  })
  expect(res.statusCode).toBe(200)
}
const dests = async (t: any, p: string) =>
  (await t.app.inject({ method: 'GET', url: '/api/destinations', headers: asProfile(p) })).json()
const legs = async (t: any, p: string) =>
  (await t.app.inject({ method: 'GET', url: '/api/legs', headers: asProfile(p) })).json()

/** Rough east/north offset in meters -> degrees (fine for a few km). */
function offset(p: { lat: number; lon: number }, eastM: number, northM: number) {
  const dLat = northM / 111_320
  const dLon = eastM / (111_320 * Math.cos((p.lat * Math.PI) / 180))
  return { lat: p.lat + dLat, lon: p.lon + dLon }
}

describe('arrival is re-evaluated for the life of a stop [LOC-012]', () => {
  const B = { lat: 40.0, lon: -105.0 }

  it('a destination made active while already parked on it arrives [LOC-012]', async () => {
    const t = await createTestApp()
    opened.push(t)
    const parent = await t.addProfile('Dad', 'parent')

    // Drive in and park at B's spot BEFORE B exists as a destination.
    await sync(t, parent.id, [
      { ...offset(B, 2000, 0), ts: at(0) },
      { ...offset(B, 500, 0), ts: at(60) },
      { ...B, ts: at(120) }, // stationary pair opens a stop anchored here
      { ...B, ts: at(180) },
    ])
    expect((await dests(t, parent.id)).length).toBe(0)

    // Add B right where we're parked; it becomes active.
    const resB = await t.app.inject({
      method: 'POST', url: '/api/destinations', headers: asProfile(parent.id),
      payload: { name: 'Grandmas House', lat: B.lat, lon: B.lon },
    })
    expect(resB.statusCode).toBe(201)
    expect((await dests(t, parent.id))[0].status).toBe('active')

    // Keep sitting parked at B — the SAME stop, no new stop opens.
    await sync(t, parent.id, [
      { ...B, ts: at(240) },
      { ...B, ts: at(1200) }, // 18 more min parked
    ])

    const d = await dests(t, parent.id)
    const l = await legs(t, parent.id)
    expect(d[0].status).toBe('arrived')
    expect(l).toHaveLength(1)
    expect(l[0].destination_id).toBe(d[0].id)
  })

  it('arrival counts once the vehicle settles within range, even if the anchor landed short [LOC-012]', async () => {
    const t = await createTestApp()
    opened.push(t)
    const parent = await t.addProfile('Dad', 'parent')

    // Tight arrival radius so the geometry is unambiguous; stop radius default 100 m.
    await t.app.inject({
      method: 'PUT', url: '/api/config', headers: asProfile(parent.id),
      payload: { arrival_radius_m: 120 },
    })
    const resB = await t.app.inject({
      method: 'POST', url: '/api/destinations', headers: asProfile(parent.id),
      payload: { name: 'Trailhead', lat: B.lat, lon: B.lon },
    })
    expect(resB.statusCode).toBe(201)

    // Coast to a halt: the anchor lands ~180 m short (outside 120 m), then we creep to the
    // pin and sit. Old engine checked only the anchor once -> permanent miss.
    await sync(t, parent.id, [
      { ...offset(B, 1500, 0), ts: at(0) },
      { ...offset(B, 180, 0), ts: at(60) }, // first stationary ping -> anchor, 180 m out
      { ...offset(B, 150, 0), ts: at(120) }, // opens the stop (within 100 m of anchor)
      { ...offset(B, 20, 0), ts: at(180) }, // settled onto the pin (20 m), within 120 m now
      { ...B, ts: at(600) },
    ])

    const d = await dests(t, parent.id)
    const l = await legs(t, parent.id)
    expect(d[0].status).toBe('arrived')
    expect(l).toHaveLength(1)
  })
})
