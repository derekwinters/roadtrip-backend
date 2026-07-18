import { expect } from 'vitest'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { toClientEvents, type Scenario, type SimPing } from '../../scripts/simulate-trip.js'
import { haversineMeters } from '../../src/location/geo.js'

export interface ScenarioHarness {
  t: TestApp
  parent: { id: string }
  /** Created destination rows, in scenario order. */
  destinations: any[]
}

/** Boots a real app, a parent profile, and the scenario's destinations. */
export async function setupScenario(scenario: Scenario): Promise<ScenarioHarness> {
  const t = await createTestApp()
  const parent = await t.addProfile('Dad', 'parent')
  const destinations: any[] = []
  for (const d of scenario.destinations) {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/destinations',
      headers: asProfile(parent.id),
      payload: { name: d.name, lat: d.lat, lon: d.lon },
    })
    expect(res.statusCode).toBe(201)
    destinations.push(res.json())
  }
  return { t, parent, destinations }
}

/** Feeds simulator pings through the real sync API in chunked batches. */
export async function runPings(h: ScenarioHarness, pings: SimPing[], chunkSize = 200): Promise<void> {
  const events = toClientEvents(pings)
  for (let i = 0; i < events.length; i += chunkSize) {
    const res = await h.t.app.inject({
      method: 'POST',
      url: '/api/sync/batch',
      headers: asProfile(h.parent.id),
      payload: { device_id: 'simulator', events: events.slice(i, i + chunkSize) },
    })
    expect(res.statusCode).toBe(200)
    for (const r of res.json().results) expect(r.status).toBe('accepted')
  }
}

export async function eventsOfType(
  h: ScenarioHarness,
  type: string,
): Promise<Array<{ seq: number; payload: any; client_ts: string }>> {
  const res = await h.t.app.inject({
    method: 'GET',
    url: `/api/events?types=${type}&limit=500`,
    headers: asProfile(h.parent.id),
  })
  return res.json().events
}

export async function getJson(h: ScenarioHarness, url: string): Promise<any> {
  const res = await h.t.app.inject({ method: 'GET', url, headers: asProfile(h.parent.id) })
  expect(res.statusCode).toBe(200)
  return res.json()
}

/**
 * Finds the first "stationary run" in a ping trail: consecutive pings within
 * `radiusM` of the run's first ping. Returns the run start index and the index of
 * the first ping after the run (the one that would end the stop), mirroring the
 * spec's stop definitions.
 */
export function findStationaryRun(pings: SimPing[], fromIndex = 0, radiusM = 100): { start: number; endAfter: number } {
  for (let i = fromIndex; i < pings.length - 1; i++) {
    if (haversineMeters(pings[i]!, pings[i + 1]!) <= radiusM) {
      let j = i + 1
      while (j < pings.length && haversineMeters(pings[i]!, pings[j]!) <= radiusM) j++
      return { start: i, endAfter: j }
    }
  }
  throw new Error('no stationary run found')
}

export const minutesBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000
