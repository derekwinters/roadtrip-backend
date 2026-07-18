import { describe, it, expect } from 'vitest'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'

/**
 * First-run bootstrap (docs/spec/04-profiles.md, PRO-008): while zero profiles exist,
 * POST /api/profiles works unauthenticated but must create a parent; the moment one
 * profile exists the ordinary PRO-002/004/005 rules apply again, and the emptiness
 * check is race-safe. Each test gets a brand-new (empty) database.
 */

async function withApp(fn: (t: TestApp) => Promise<void>): Promise<void> {
  const t = await createTestApp()
  try {
    await fn(t)
  } finally {
    await t.close()
  }
}

describe('first-run bootstrap', () => {
  it('empty DB: unauthenticated parent create → 201 with a null-actor profile.created [PRO-008]', async () =>
    withApp(async (t) => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/profiles',
        payload: { name: 'Dad', avatar: '🚗', role: 'parent' },
      })
      expect(res.statusCode).toBe(201)
      const profile = res.json()
      expect(profile.role).toBe('parent')
      expect(profile.name).toBe('Dad')

      // The bootstrap parent is immediately usable and listed (PRO-001 datasource).
      const list = await t.app.inject({ method: 'GET', url: '/api/profiles' })
      expect(list.json()).toHaveLength(1)

      // profile.created is emitted as usual (PRO-007), with a null actor for this one path.
      const { rows } = await t.db.pool.query(
        `SELECT actor_id, payload FROM events WHERE type = 'profile.created'`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].actor_id).toBeNull()
      expect(rows[0].payload.profile_id).toBe(profile.id)
      expect(rows[0].payload.role).toBe('parent')
    }))

  it('empty DB: bootstrap with kid role → 400 validation and nothing persisted [PRO-008]', async () =>
    withApp(async (t) => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/profiles',
        payload: { name: 'Sam', role: 'kid' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('validation')

      const { rows } = await t.db.pool.query('SELECT COUNT(*)::int AS n FROM profiles')
      expect(rows[0].n).toBe(0)
      const events = await t.db.pool.query(`SELECT 1 FROM events WHERE type = 'profile.created'`)
      expect(events.rowCount).toBe(0)
    }))

  it('empty DB: two concurrent bootstraps → exactly one 201, the other 4xx [PRO-008]', async () =>
    withApp(async (t) => {
      const fire = (name: string) =>
        t.app.inject({ method: 'POST', url: '/api/profiles', payload: { name, role: 'parent' } })
      const [a, b] = await Promise.all([fire('Dad'), fire('Mom')])

      const codes = [a.statusCode, b.statusCode].sort((x, y) => x - y)
      expect(codes[0]).toBe(201) // exactly one winner…
      expect(codes[1]).toBeGreaterThanOrEqual(400) // …a double 201 is a race bug
      expect(codes[1]).toBeLessThan(500)

      const { rows } = await t.db.pool.query('SELECT COUNT(*)::int AS n FROM profiles')
      expect(rows[0].n).toBe(1)
      const events = await t.db.pool.query(`SELECT 1 FROM events WHERE type = 'profile.created'`)
      expect(events.rowCount).toBe(1)
    }))

  it('non-empty DB: missing header still gets 401 [PRO-008] [PRO-004]', async () =>
    withApp(async (t) => {
      await t.addProfile('Dad', 'parent')
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/profiles',
        payload: { name: 'Intruder', role: 'parent' },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('unauthenticated')
      // The refusal explains itself: profiles exist, sign in as a parent — never the
      // generic missing-profile message that misleads first-run clients (PRO-008).
      expect(res.json().error.message).toMatch(/profiles already exist/i)
      expect(res.json().error.message).toMatch(/parent/i)
      expect(res.json().error.message).not.toMatch(/unknown or missing/i)
    }))

  it('non-empty DB: kid header still gets 403 parent_required [PRO-008] [PRO-002] [PRO-005]', async () =>
    withApp(async (t) => {
      await t.addProfile('Dad', 'parent')
      const kid = await t.addProfile('Sam', 'kid')
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/profiles',
        headers: asProfile(kid.id),
        payload: { name: 'Sneaky', role: 'parent' },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe('parent_required')
    }))
})
