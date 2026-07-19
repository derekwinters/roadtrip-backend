import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { seedDemo } from '../../scripts/seed-demo.js'

let t: TestApp
let viewer: string

beforeAll(async () => {
  t = await createTestApp()
  await seedDemo(t.app)
  const profiles = (await t.app.inject({ method: 'GET', url: '/api/profiles' })).json()
  viewer = profiles.find((p: any) => p.name === 'Sam').id
}, 120_000)
afterAll(async () => await t.close())

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: asProfile(viewer) })

describe('demo trip seed', () => {
  it('leaves every read endpoint non-empty for UI development [SIM-007]', async () => {
    const journal = (await get('/api/journal?limit=200')).json()
    const kinds = new Set(journal.entries.map((e: any) => e.kind))
    expect(journal.entries.length).toBeGreaterThan(8)
    for (const kind of ['post', 'stop', 'state_crossing', 'leg_arrival', 'game_result']) {
      expect(kinds, `journal is missing a ${kind} entry`).toContain(kind)
    }

    const map = (await get('/api/map')).json()
    expect(map.current).not.toBeNull()
    expect(map.breadcrumb.length).toBeGreaterThan(20)

    const checklist = (await get('/api/checklist')).json()
    const states = checklist.states.map((s: any) => s.state_code)
    expect(states).toContain('CO')
    expect(states).toContain('WY')
    expect(checklist.stops.length).toBeGreaterThan(0)
    expect(checklist.cities.length).toBeGreaterThan(0)

    const legs = (await get('/api/legs')).json()
    expect(legs.length).toBeGreaterThanOrEqual(1)
    expect(legs[0].summary.miles).toBeGreaterThan(80)

    const trip = (await get('/api/trip/summary')).json()
    expect(trip.miles).toBeGreaterThan(80)
    expect(trip.games_played).toBeGreaterThanOrEqual(2)
    // Per-person breakdowns are no longer emitted (SUM-002).
    expect(trip).not.toHaveProperty('wins_by_profile')

    const games = (await get('/api/games')).json()
    expect(games.length).toBe(3)
    expect(games.filter((g: any) => g.status === 'finished').length).toBe(2)
    expect(games.filter((g: any) => g.status === 'active').length).toBe(1)

    const notifications = (await get('/api/notifications')).json()
    expect(notifications.items.length).toBeGreaterThan(0)

    // License plate bingo: a partially filled card with exactly one removal (covers: BNG-006).
    const bingo = (await get('/api/bingo')).json()
    expect(bingo.cells.length).toBeGreaterThanOrEqual(3)
    expect(bingo.log.filter((l: any) => l.action === 'unspotted')).toHaveLength(1)
    expect(Object.keys(bingo.counts).length).toBeGreaterThanOrEqual(2)
  })
})
