import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { buildScenario } from '../../scripts/simulate-trip.js'
import { haversineMeters } from '../../src/location/geo.js'
import { appendEvent } from '../../src/events/store.js'
import { setupScenario, runPings, getJson, minutesBetween, type ScenarioHarness } from './support.js'

const START = '2026-07-05T12:00:00.000Z'
const startMs = Date.parse(START)
const atS = (s: number) => new Date(startMs + s * 1000).toISOString()

const opened: ScenarioHarness[] = []
afterAll(async () => {
  for (const h of opened) await h.t.close()
})

describe('simulated multi-leg day (through the real API)', () => {
  it('the trip summary equals the sum of completed legs plus the in-progress leg [SUM-003]', async () => {
    const scenario = buildScenario('multi_leg_day', { startTime: START })
    expect(scenario.destinations).toHaveLength(2)
    const h = await setupScenario(scenario)
    opened.push(h)

    const kid = await h.t.addProfile('Sam', 'kid')
    // Games finished during the day: two in leg 1, one after the final arrival.
    const game = async (winner: string, loser: string, tsIso: string) =>
      appendEvent(h.t.db.pool, {
        type: 'game.finished',
        actorId: null,
        payload: {
          game_id: randomUUID(),
          game_type: 'tictactoe',
          result: 'win',
          winner_profile_id: winner,
          loser_profile_id: loser,
          move_count: 7,
        },
        clientTs: tsIso,
      })
    await game(h.parent.id, kid.id, atS(3000))
    await game(h.parent.id, kid.id, atS(5000))
    await game(kid.id, h.parent.id, atS(17000))

    await runPings(h, scenario.pings)

    const legs = await getJson(h, '/api/legs')
    expect(legs).toHaveLength(2)
    const [leg1, leg2] = legs
    expect(leg1.destination_id).toBe(h.destinations[0].id)
    expect(leg2.destination_id).toBe(h.destinations[1].id)

    // Sanity-pin the scenario's own reference expectations.
    const d1 = scenario.destinations[0]!
    const d2 = scenario.destinations[1]!
    const arrival1Ts = scenario.pings.find((p) => haversineMeters(p, d1) < 1)!.ts
    const arrival2Ts = scenario.pings.find((p) => haversineMeters(p, d2) < 1)!.ts
    expect(leg1.arrived_at).toBe(arrival1Ts)
    expect(leg2.arrived_at).toBe(arrival2Ts)
    expect(leg2.started_at).toBe(arrival1Ts)
    expect(leg1.summary.stop_count).toBe(0) // straight shot to destination 1
    expect(leg2.summary.stop_count).toBe(2) // the lunch layover + the gas stop
    expect(leg1.summary.games_played).toBe(2)
    expect(leg2.summary.games_played).toBe(0)
    expect(leg1.summary.states).toEqual(['CO', 'WY'])
    expect(leg2.summary.states).toEqual(['WY'])

    const trip = await getJson(h, '/api/trip/summary')
    const map = await getJson(h, '/api/map')
    const checklist = await getJson(h, '/api/checklist')

    // In-progress leg (after the last arrival), derived independently of /api/trip/summary.
    const lastPingTs = scenario.pings[scenario.pings.length - 1]!.ts
    const ipWall = minutesBetween(arrival2Ts, lastPingTs)
    const ipStops = checklist.stops.filter((s: any) => Date.parse(s.started_at) >= Date.parse(arrival2Ts))
    expect(ipStops).toHaveLength(1) // the layover at destination 2
    const ipStopMinutes = ipStops.reduce((sum: number, s: any) => sum + s.duration_min, 0)
    const ipMoving = ipWall - ipStopMinutes
    const ipMiles = map.leg_miles
    expect(ipMiles).toBeGreaterThan(1)

    // SUM-003: the whole equals the sum of its parts.
    expect(trip.wall_minutes).toBeCloseTo(leg1.summary.wall_minutes + leg2.summary.wall_minutes + ipWall, 6)
    expect(trip.moving_minutes).toBeCloseTo(leg1.summary.moving_minutes + leg2.summary.moving_minutes + ipMoving, 6)
    expect(trip.miles).toBeCloseTo(leg1.summary.miles + leg2.summary.miles + ipMiles, 6)
    expect(trip.stop_count).toBe(leg1.summary.stop_count + leg2.summary.stop_count + ipStops.length)
    expect(trip.games_played).toBe(leg1.summary.games_played + leg2.summary.games_played + 1)
    const statesUnion = new Set([...leg1.summary.states, ...leg2.summary.states])
    expect(trip.states_count).toBe(statesUnion.size)
    expect(trip.wins_by_profile).toEqual({ [h.parent.id]: 2, [kid.id]: 1 })
    expect(trip.journal_posts_by_profile).toEqual({})
  })
})
