import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')

const readJson = (file: string): unknown => JSON.parse(readFileSync(path.join(DATA_DIR, file), 'utf8'))

/**
 * The spottable plate codes (docs/spec/14-bingo.md, BNG-001): the 2-letter codes of the
 * bundled US state dataset (50 states + DC, the same file the geocoder uses) unioned with
 * the bundled Canadian provinces/territories dataset — 64 codes. Loaded once from offline
 * data files (SYS-007 — no runtime internet).
 */
export const PLATE_STATE_CODES: ReadonlySet<string> = new Set<string>([
  ...(readJson('us-states.geojson') as { features: Array<{ properties: { code: string } }> }).features.map(
    (f) => f.properties.code,
  ),
  ...Object.keys(readJson('ca-provinces.json') as Record<string, string>),
])
