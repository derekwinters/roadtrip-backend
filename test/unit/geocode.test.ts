import { describe, it, expect } from 'vitest'
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
    const hit = nearestCityWithin(39.7392, -104.9903, 10)
    expect(hit?.city).toBe('Denver')
    expect(hit?.state_code).toBe('CO')
    expect(hit!.distanceKm).toBeLessThan(1)
  })

  it('returns null when no city centroid is within the radius, and honors a wider radius [GEO-004]', () => {
    // ~20 km east of Cheyenne on the high plains.
    const lat = 41.14
    const lon = -104.8202 + 20 / (111.19493 * Math.cos((lat * Math.PI) / 180))
    expect(nearestCityWithin(lat, lon, 10)).toBeNull()
    const wide = nearestCityWithin(lat, lon, 50)
    expect(wide?.city).toBe('Cheyenne')
    expect(wide!.distanceKm).toBeGreaterThan(15)
  })

  it('picks the closest city when several are in range [GEO-006]', () => {
    // Between Loveland and Fort Collins, closer to Loveland.
    const hit = nearestCityWithin(40.45, -105.075, 50)
    expect(hit?.city).toBe('Loveland')
  })
})
