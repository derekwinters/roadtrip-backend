/**
 * Offline reverse geocoding (docs/spec/06-location.md, GEO-001..006).
 *
 * Datasets are bundled in the repo/image — no runtime internet (SYS-007):
 * - data/us-states.geojson: simplified state polygons ([lon, lat] coordinates).
 * - data/us-cities.json: city centroids with state and population.
 *
 * Both datasets are parsed once and cached in module state.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { haversineMeters } from './geo.js'

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')

type Ring = Array<[number, number]> // [lon, lat]
type PolygonCoords = Ring[] // outer ring + holes

interface StateShape {
  name: string
  code: string
  bbox: [number, number, number, number] // minLon, minLat, maxLon, maxLat
  polygons: PolygonCoords[]
}

interface CityRow {
  city: string
  state_code: string
  lat: number
  lon: number
  population: number
}

export interface StateHit {
  state: string
  code: string
}

export interface CityHit {
  city: string
  state_code: string
  lat: number
  lon: number
  distanceKm: number
}

let statesCache: StateShape[] | null = null
let citiesCache: CityRow[] | null = null

function ringBounds(rings: PolygonCoords[], bbox: [number, number, number, number]): void {
  for (const poly of rings) {
    for (const [lon, lat] of poly[0] ?? []) {
      if (lon < bbox[0]) bbox[0] = lon
      if (lat < bbox[1]) bbox[1] = lat
      if (lon > bbox[2]) bbox[2] = lon
      if (lat > bbox[3]) bbox[3] = lat
    }
  }
}

function loadStates(): StateShape[] {
  if (statesCache) return statesCache
  const raw = JSON.parse(readFileSync(path.join(DATA_DIR, 'us-states.geojson'), 'utf8'))
  const shapes: StateShape[] = []
  for (const feature of raw.features as any[]) {
    const geometry = feature.geometry
    const polygons: PolygonCoords[] =
      geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
    const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
    ringBounds(polygons, bbox)
    shapes.push({ name: feature.properties.name, code: feature.properties.code, bbox, polygons })
  }
  statesCache = shapes
  return shapes
}

function loadCities(): CityRow[] {
  if (citiesCache) return citiesCache
  citiesCache = JSON.parse(readFileSync(path.join(DATA_DIR, 'us-cities.json'), 'utf8')) as CityRow[]
  return citiesCache
}

/** Standard ray casting in [lon, lat] space. */
function pointInRing(lat: number, lon: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function pointInPolygon(lat: number, lon: number, polygon: PolygonCoords): boolean {
  const outer = polygon[0]
  if (!outer || !pointInRing(lat, lon, outer)) return false
  for (let k = 1; k < polygon.length; k++) {
    if (pointInRing(lat, lon, polygon[k]!)) return false // inside a hole
  }
  return true
}

/**
 * State containing the point, or null when the point is outside every polygon
 * (over water / border gaps — GEO-005 keeps the previous state in that case).
 */
export function stateForPoint(lat: number, lon: number): StateHit | null {
  for (const shape of loadStates()) {
    const [minLon, minLat, maxLon, maxLat] = shape.bbox
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue
    for (const polygon of shape.polygons) {
      if (pointInPolygon(lat, lon, polygon)) return { state: shape.name, code: shape.code }
    }
  }
  return null
}

/** Nearest city centroid within `radiusKm`, or null (GEO-004/GEO-006). */
export function nearestCityWithin(lat: number, lon: number, radiusKm: number): CityHit | null {
  const maxLatDelta = radiusKm / 111.19493 // quick reject band
  let best: CityHit | null = null
  for (const city of loadCities()) {
    if (Math.abs(city.lat - lat) > maxLatDelta) continue
    const distanceKm = haversineMeters({ lat, lon }, city) / 1000
    if (distanceKm <= radiusKm && (best === null || distanceKm < best.distanceKm)) {
      best = { city: city.city, state_code: city.state_code, lat: city.lat, lon: city.lon, distanceKm }
    }
  }
  return best
}
