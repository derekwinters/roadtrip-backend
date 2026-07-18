/**
 * Pure geometry helpers for the location pipeline (docs/spec/06-location.md).
 * Mileage is always the haversine sum along consecutive breadcrumb points (LOC-007),
 * never the straight line between endpoints.
 */

export interface LatLon {
  lat: number
  lon: number
}

export const EARTH_RADIUS_M = 6371008.8
export const METERS_PER_MILE = 1609.344

const toRad = (deg: number): number => (deg * Math.PI) / 180

/** Great-circle distance in meters between two points. */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s))
}

export function metersToMiles(meters: number): number {
  return meters / METERS_PER_MILE
}

export function haversineMiles(a: LatLon, b: LatLon): number {
  return metersToMiles(haversineMeters(a, b))
}

/** Breadcrumb mileage: sum of haversine distances between consecutive points. */
export function pathMiles(points: readonly LatLon[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += haversineMiles(points[i - 1]!, points[i]!)
  return total
}

/** Offsets a point by meters (north/east; negative = south/west). Good for small distances. */
export function offsetMeters(p: LatLon, northM: number, eastM: number): LatLon {
  const degPerMeter = 180 / (Math.PI * EARTH_RADIUS_M)
  return {
    lat: p.lat + northM * degPerMeter,
    lon: p.lon + (eastM * degPerMeter) / Math.cos(toRad(p.lat)),
  }
}

/**
 * Uniformly samples a breadcrumb down to `maxPoints`, always keeping the first and
 * last points and the original order (LOC-008 `max_points` decimation).
 */
export function decimate<T>(points: readonly T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) return [...points]
  if (maxPoints <= 1) return points.length > 0 ? [points[0]!] : []
  const out: T[] = []
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.round((i * (points.length - 1)) / (maxPoints - 1))]!)
  }
  return out
}
