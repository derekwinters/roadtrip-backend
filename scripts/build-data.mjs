#!/usr/bin/env node
/**
 * Regenerates the bundled offline geo/dictionary datasets (GEO-001..006, GAME-013):
 *   data/us-states.geojson — state polygons from us-atlas (TopoJSON → GeoJSON)
 *   data/us-cities.json    — US cities ≥ 20k population from all-the-cities
 *   data/words.txt         — hangman dictionary from word-list (3..15 letter words)
 * Committed outputs; rerun only when upgrading the source packages.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')

const FIPS_TO_USPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT',
  10: 'DE', 11: 'DC', 12: 'FL', 13: 'GA', 15: 'HI', 16: 'ID', 17: 'IL', 18: 'IN',
  19: 'IA', 20: 'KS', 21: 'KY', 22: 'LA', 23: 'ME', 24: 'MD', 25: 'MA', 26: 'MI',
  27: 'MN', 28: 'MS', 29: 'MO', 30: 'MT', 31: 'NE', 32: 'NV', 33: 'NH', 34: 'NJ',
  35: 'NM', 36: 'NY', 37: 'NC', 38: 'ND', 39: 'OH', 40: 'OK', 41: 'OR', 42: 'PA',
  44: 'RI', 45: 'SC', 46: 'SD', 47: 'TN', 48: 'TX', 49: 'UT', 50: 'VT', 51: 'VA',
  53: 'WA', 54: 'WV', 55: 'WI', 56: 'WY',
}

// --- states ---------------------------------------------------------------
const { feature } = await import('topojson-client')
const topo = JSON.parse(await readFile(require.resolve('us-atlas/states-10m.json'), 'utf8'))
const fc = feature(topo, topo.objects.states)
fc.features = fc.features
  .filter((f) => FIPS_TO_USPS[f.id])
  .map((f) => ({
    type: 'Feature',
    id: f.id,
    properties: { name: f.properties.name, code: FIPS_TO_USPS[f.id] },
    geometry: f.geometry,
  }))
await writeFile(path.join(root, 'data/us-states.geojson'), JSON.stringify(fc))
console.log(`us-states.geojson: ${fc.features.length} states`)

// --- cities ---------------------------------------------------------------
const cities = require('all-the-cities')
const us = cities
  .filter((c) => c.country === 'US' && c.population >= 20000 && FIPS_TO_USPS_HAS(c.adminCode))
  .map((c) => ({
    city: c.name,
    state_code: c.adminCode,
    lat: c.loc.coordinates[1],
    lon: c.loc.coordinates[0],
    population: c.population,
  }))
  .sort((a, b) => b.population - a.population)
function FIPS_TO_USPS_HAS(code) {
  return Object.values(FIPS_TO_USPS).includes(code)
}
await writeFile(path.join(root, 'data/us-cities.json'), JSON.stringify(us))
console.log(`us-cities.json: ${us.length} cities`)

// --- words ------------------------------------------------------------------
const wordListPath = (await import('word-list')).default
const words = (await readFile(wordListPath, 'utf8'))
  .split('\n')
  .filter((w) => /^[a-z]{3,15}$/.test(w))
await writeFile(path.join(root, 'data/words.txt'), words.join('\n') + '\n')
console.log(`words.txt: ${words.length} words`)
