import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')

/**
 * The spottable plate codes (docs/spec/14-bingo.md, BNG-001): the 2-letter codes of the
 * bundled state dataset plus DC. Loaded once from the same offline dataset the geocoder
 * uses (SYS-007 — no runtime internet).
 */
export const PLATE_STATE_CODES: ReadonlySet<string> = new Set<string>([
  ...(
    JSON.parse(readFileSync(path.join(DATA_DIR, 'us-states.geojson'), 'utf8')).features as Array<{
      properties: { code: string }
    }>
  ).map((f) => f.properties.code),
  'DC',
])
