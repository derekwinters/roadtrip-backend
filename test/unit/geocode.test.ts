import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stateForPoint, nearestCityWithin } from '../../src/location/geocode.js'

describe('offline state lookup (bundled polygons)', () => {
  it('resolves points via point-in-polygon against the bundled dataset [GEO-001]', () => {
    expect(stateForPoint(39.7392, -104.9903)).toEqual({ state: 'Colorado', code: 'CO' })
    expect(stateForPoint(41.14, -104.8202)).toEqual({ state: 'Wyoming', code: 'WY' })
  })

  it('resolves points either side of the CO/WY border on I-25', () => {
    expect(stateForPoint(40.995, -104.93)?.code).toBe('CO')
    expect(stateForPoint(41.005, -104.9)?.code).toBe('WY')
  })

  it('handles MultiPolygon states (secondary landmasses)', () => {
    // Michigan Upper Peninsula and an Alabama barrier island are separate polygons.
    expect(stateForPoint(46.5, -87.4)?.code).toBe('MI')
    expect(stateForPoint(30.2553, -88.11)?.code).toBe('AL')
  })

  it('returns null for points outside all polygons (open water) [GEO-005]', () => {
    expect(stateForPoint(25.0, -90.0)).toBeNull() // Gulf of Mexico
    expect(stateForPoint(37.7, -123.5)).toBeNull() // Pacific, off San Francisco
  })
})

describe('nearest-city lookup (bundled city list)', () => {
  it('finds the city when within city_radius_km [GEO-004]', () => {
    const hit = nearestCityWithin(39.7392, -104.9903, 10, 5000)
    expect(hit?.city).toBe('Denver')
    expect(hit?.state_code).toBe('CO')
    expect(hit!.distanceKm).toBeLessThan(1)
  })

  it('returns null when no city centroid is within the radius, and honors a wider radius [GEO-004]', () => {
    // ~20 km east of Cheyenne on the high plains.
    const lat = 41.14
    const lon = -104.8202 + 20 / (111.19493 * Math.cos((lat * Math.PI) / 180))
    expect(nearestCityWithin(lat, lon, 10, 5000)).toBeNull()
    // Small towns (e.g. Ranchettes, WY) lie nearer; a 50k threshold leaves Cheyenne the only candidate.
    const wide = nearestCityWithin(lat, lon, 50, 50_000)
    expect(wide?.city).toBe('Cheyenne')
    expect(wide!.distanceKm).toBeGreaterThan(15)
  })

  it('picks the closest city when several are in range [GEO-006]', () => {
    // Between Loveland and Fort Collins, closer to Loveland.
    const hit = nearestCityWithin(40.45, -105.075, 50, 5000)
    expect(hit?.city).toBe('Loveland')
  })
})

describe('bundled city list and the population threshold', () => {
  const MEAD = { lat: 40.23332, lon: -104.99859 } // population 4,476

  it('ships every US place from all-the-cities with no population cutoff [GEO-009]', () => {
    const rows = JSON.parse(readFileSync(new URL('../../data/us-cities.json', import.meta.url), 'utf8')) as Array<any>
    expect(rows.length).toBeGreaterThan(16_000)
    expect(rows.filter((r) => r.population < 5000).length).toBeGreaterThan(8_000)
    for (const r of rows) {
      expect(typeof r.city).toBe('string')
      expect(r.state_code).toMatch(/^[A-Z]{2}$/)
      expect(Number.isFinite(r.lat) && Number.isFinite(r.lon)).toBe(true)
      expect(Number.isFinite(r.population)).toBe(true)
    }
  })

  it('matches a small place only when the minimum allows it [GEO-009]', () => {
    expect(nearestCityWithin(MEAD.lat, MEAD.lon, 2, 0)?.city).toBe('Mead')
    expect(nearestCityWithin(MEAD.lat, MEAD.lon, 2, 5000)).toBeNull()
  })

  it('skips a nearer below-threshold place in favor of a farther qualifying city [GEO-009]', () => {
    const hit = nearestCityWithin(MEAD.lat, MEAD.lon, 15, 5000)
    expect(hit).not.toBeNull()
    expect(hit!.city).not.toBe('Mead')
    expect(hit!.distanceKm).toBeGreaterThan(2)
  })
})
