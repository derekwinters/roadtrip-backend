import { describe, it, expect } from 'vitest'
import {
  haversineMeters,
  haversineMiles,
  metersToMiles,
  offsetMeters,
  pathMiles,
  decimate,
} from '../../src/location/geo.js'

const DENVER = { lat: 39.7392, lon: -104.9903 }
const CHEYENNE = { lat: 41.14, lon: -104.8202 }
const LA = { lat: 34.0522, lon: -118.2437 }
const NYC = { lat: 40.7128, lon: -74.006 }

describe('haversine distance (mileage basis for LOC-007)', () => {
  it('matches known great-circle distances within 0.1% [LOC-007]', () => {
    // Reference values computed with the standard haversine formula, R = 6371008.8 m.
    expect(haversineMeters(DENVER, CHEYENNE)).toBeCloseTo(156425.76, -2)
    expect(haversineMeters(LA, NYC) / 1000).toBeCloseTo(3935.75, 0)
  })

  it('is zero for identical points and symmetric', () => {
    expect(haversineMeters(DENVER, DENVER)).toBe(0)
    expect(haversineMeters(DENVER, CHEYENNE)).toBeCloseTo(haversineMeters(CHEYENNE, DENVER), 6)
  })

  it('converts meters to miles', () => {
    expect(metersToMiles(1609.344)).toBeCloseTo(1, 9)
    expect(haversineMiles(DENVER, CHEYENNE)).toBeCloseTo(156425.76 / 1609.344, 1)
  })

  it('offsetMeters moves a point by the requested ground distance', () => {
    const north = offsetMeters(DENVER, 100, 0)
    expect(haversineMeters(DENVER, north)).toBeCloseTo(100, 1)
    const east = offsetMeters(DENVER, 0, 250)
    expect(haversineMeters(DENVER, east)).toBeCloseTo(250, 0)
    const both = offsetMeters(DENVER, 300, 400)
    expect(haversineMeters(DENVER, both)).toBeCloseTo(500, 0)
  })

  it('pathMiles sums consecutive segments (breadcrumb, never endpoint straight-line)', () => {
    const mid = { lat: 40.4, lon: -104.99 }
    const zigzag = [DENVER, mid, DENVER, mid]
    const oneHop = haversineMiles(DENVER, mid)
    expect(pathMiles(zigzag)).toBeCloseTo(3 * oneHop, 6)
    expect(pathMiles([DENVER])).toBe(0)
    expect(pathMiles([])).toBe(0)
  })
})

describe('breadcrumb decimation (LOC-008 max_points)', () => {
  const points = Array.from({ length: 100 }, (_, i) => ({ id: i }))

  it('returns the input untouched when already within budget', () => {
    expect(decimate(points, 100)).toEqual(points)
    expect(decimate(points, 500)).toEqual(points)
  })

  it('keeps first and last points and preserves order when decimating [LOC-008]', () => {
    const out = decimate(points, 10)
    expect(out).toHaveLength(10)
    expect(out[0]).toEqual({ id: 0 })
    expect(out[out.length - 1]).toEqual({ id: 99 })
    const ids = out.map((p) => p.id)
    expect([...ids].sort((a, b) => a - b)).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('handles tiny budgets and tiny inputs', () => {
    expect(decimate(points, 2)).toEqual([{ id: 0 }, { id: 99 }])
    expect(decimate([{ id: 1 }], 5)).toEqual([{ id: 1 }])
    expect(decimate([], 5)).toEqual([])
  })
})
