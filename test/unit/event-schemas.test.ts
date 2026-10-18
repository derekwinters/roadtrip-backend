import { describe, it, expect } from 'vitest'
import { validateEventPayload } from '../../src/events/schemas.js'

// Guards the event payload schemas across the zod 3 -> 4 migration: ids keep the hex 8-4-4-4-12
// acceptance they have always had, and record fields keep their defaults and rejections.
describe('event payload schemas (EVT-003)', () => {
  const nonRfcIds = ['00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111']

  it('accepts any hex 8-4-4-4-12 id, not only RFC 9562 variants [EVT-003]', () => {
    for (const id of nonRfcIds) {
      const r = validateEventPayload('game.joined', { game_id: id, profile_id: id })
      expect(r.ok, id).toBe(true)
    }
  })

  it('rejects a malformed id [EVT-003]', () => {
    const r = validateEventPayload('game.joined', { game_id: 'not-a-uuid', profile_id: nonRfcIds[0] })
    expect(r.ok).toBe(false)
  })

  it('defaults game.created options to {} and rejects a non-object [EVT-003]', () => {
    const base = { game_id: nonRfcIds[0], game_type: 'chess', mode: 'open' }
    const ok = validateEventPayload('game.created', base)
    expect(ok).toEqual({ ok: true, payload: { ...base, options: {} } })
    expect(validateEventPayload('game.created', { ...base, options: [] }).ok).toBe(false)
  })

  it('accepts config.updated numeric changes and rejects non-numeric values [EVT-003]', () => {
    expect(validateEventPayload('config.updated', { changes: { ping_interval_s: 60 } }).ok).toBe(true)
    expect(validateEventPayload('config.updated', { changes: { ping_interval_s: 'x' } }).ok).toBe(false)
  })
})
