import { describe, it, expect } from 'vitest'
import { PLATE_STATE_CODES } from '../../src/bingo/states.js'
import { eventPayloadSchemas } from '../../src/events/schemas.js'

/** The spottable plate codes (docs/spec/14-bingo.md, BNG-001). */

const CANADA = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'ON', 'PE', 'QC', 'SK', 'NT', 'NU', 'YT']

describe('plate state codes', () => {
  it('is exactly the 51 US states + DC and the 13 Canadian provinces/territories [BNG-001]', () => {
    expect(PLATE_STATE_CODES.size).toBe(64)
    for (const code of [...CANADA, 'DC', 'CO', 'TX', 'WY']) expect(PLATE_STATE_CODES.has(code)).toBe(true)
    for (const code of PLATE_STATE_CODES) expect(code).toMatch(/^[A-Z]{2}$/)
  })

  it('accepts a Canadian code in plate payloads and still rejects unknown codes [BNG-001]', () => {
    for (const type of ['plate.spotted', 'plate.unspotted']) {
      const schema = eventPayloadSchemas[type]!
      expect(schema.safeParse({ state_code: 'ON' }).success).toBe(true)
      expect(schema.safeParse({ state_code: 'YT' }).success).toBe(true)
      expect(schema.safeParse({ state_code: 'ZZ' }).success).toBe(false)
      expect(schema.safeParse({ state_code: 'on' }).success).toBe(false)
    }
  })
})
