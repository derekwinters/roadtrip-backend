import { describe, it, expect, afterAll } from 'vitest'
import { buildScenario } from '../../scripts/simulate-trip.js'
import { stateForPoint } from '../../src/location/geocode.js'
import { setupScenario, runPings, eventsOfType, getJson, type ScenarioHarness } from './support.js'

const START = '2026-07-04T13:00:00.000Z'
const opened: ScenarioHarness[] = []
afterAll(async () => {
  for (const h of opened) await h.t.close()
})

describe('simulated state crossing (through the real API)', () => {
  it('state_crossing produces the expected crossing sequence and checklist entries [SIM-004]', async () => {
    const scenario = buildScenario('state_crossing', { startTime: START })
    const h = await setupScenario(scenario)
    opened.push(h)
    await runPings(h, scenario.pings)

    // The oracle is the bundled polygon dataset itself: find where the route crosses.
    const perPing = scenario.pings.map((p) => stateForPoint(p.lat, p.lon)?.code ?? null)
    expect(perPing[0]).toBe('CO')
    expect(perPing[perPing.length - 1]).toBe('WY')
    const firstWyIndex = perPing.indexOf('WY')
    expect(firstWyIndex).toBeGreaterThan(0)

    const crossings = await eventsOfType(h, 'location.crossing.state')
    expect(crossings.map((c) => c.payload)).toEqual([
      { state: 'Colorado', state_code: 'CO', prev_state_code: null },
      { state: 'Wyoming', state_code: 'WY', prev_state_code: 'CO' },
    ])
    expect(crossings[0]!.client_ts).toBe(scenario.pings[0]!.ts)
    expect(crossings[1]!.client_ts).toBe(scenario.pings[firstWyIndex]!.ts)

    const checklist = await getJson(h, '/api/checklist')
    expect(checklist.states).toEqual([
      { state: 'Colorado', state_code: 'CO', first_entered_at: scenario.pings[0]!.ts },
      { state: 'Wyoming', state_code: 'WY', first_entered_at: scenario.pings[firstWyIndex]!.ts },
    ])
    const cityNames = checklist.cities.map((c: any) => c.city)
    expect(cityNames).toContain('Denver')
    expect(cityNames).toContain('Cheyenne')
  })
})
