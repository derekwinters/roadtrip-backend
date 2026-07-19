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

  it('empty DB: concurrent first creates serialize; open creation lets the loser in too [PRO-008] [PRO-009]', async () =>
    withApp(async (t) => {
      const fire = (name: string) =>
        t.app.inject({ method: 'POST', url: '/api/profiles', payload: { name, role: 'parent' } })
      const [a, b] = await Promise.all([fire('Dad'), fire('Mom')])

      // With open_profile_creation on (the default) the bootstrap loser is just an
      // ordinary open create: both parents land, serialized by the advisory lock.
      expect(a.statusCode).toBe(201)
      expect(b.statusCode).toBe(201)
      const { rows } = await t.db.pool.query('SELECT COUNT(*)::int AS n FROM profiles')
      expect(rows[0].n).toBe(2)
      const events = await t.db.pool.query(`SELECT 1 FROM events WHERE type = 'profile.created'`)
      expect(events.rowCount).toBe(2)
    }))

  it('empty DB, creation off: two concurrent bootstraps → exactly one 201 [PRO-008]', async () =>
    withApp(async (t) => {
      // Closed creation cannot be configured through the API while zero profiles exist
      // (config writes need a parent), so plant the flag directly for the race check.
      await t.db.pool.query(
        `INSERT INTO config (key, value) VALUES ('open_profile_creation', 'false')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      )
      const fire = (name: string) =>
        t.app.inject({ method: 'POST', url: '/api/profiles', payload: { name, role: 'parent' } })
      const [a, b] = await Promise.all([fire('Dad'), fire('Mom')])

      const codes = [a.statusCode, b.statusCode].sort((x, y) => x - y)
      expect(codes[0]).toBe(201) // exactly one winner…
      expect(codes[1]).toBe(401) // …a double 201 is a race bug while creation is closed
      const { rows } = await t.db.pool.query('SELECT COUNT(*)::int AS n FROM profiles')
      expect(rows[0].n).toBe(1)
      const events = await t.db.pool.query(`SELECT 1 FROM events WHERE type = 'profile.created'`)
      expect(events.rowCount).toBe(1)
    }))

  it('non-empty DB, creation off: missing header gets an actionable 401 [PRO-008] [PRO-009]', async () =>
    withApp(async (t) => {
      const dad = await t.addProfile('Dad', 'parent')
      await t.closeCreation(dad.id)
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/profiles',
        payload: { name: 'Intruder', role: 'parent' },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('unauthenticated')
      // The refusal explains itself: creation is turned off, sign in as a parent — never
      // the generic missing-profile message that misleads first-run clients (PRO-008).
      expect(res.json().error.message).toMatch(/turned off/i)
      expect(res.json().error.message).toMatch(/parent/i)
      expect(res.json().error.message).not.toMatch(/unknown or missing/i)
    }))

  it('non-empty DB, creation off: kid header gets 403 parent_required [PRO-008] [PRO-002] [PRO-005]', async () =>
    withApp(async (t) => {
      const dad = await t.addProfile('Dad', 'parent')
      const kid = await t.addProfile('Sam', 'kid')
      await t.closeCreation(dad.id)
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

describe('open profile creation (default on)', () => {
  it('non-empty DB: unauthenticated create succeeds for any role with a null actor [PRO-009]', async () =>
    withApp(async (t) => {
      await t.addProfile('Dad', 'parent')

      const kidRes = await t.app.inject({
        method: 'POST',
        url: '/api/profiles',
        payload: { name: 'Cousin', role: 'kid' },
      })
      expect(kidRes.statusCode).toBe(201)
      expect(kidRes.json().role).toBe('kid')

      // Any role: a second parent can self-serve too — the flag is the control, not roles.
      const parentRes = await t.app.inject({
        method: 'POST',
        url: '/api/profiles',
        payload: { name: 'Grandma', role: 'parent' },
      })
      expect(parentRes.statusCode).toBe(201)

      const { rows } = await t.db.pool.query(
        `SELECT actor_id, payload FROM events WHERE type = 'profile.created' AND payload->>'name' = 'Cousin'`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].actor_id).toBeNull() // nobody signed in — recorded as such
    }))

  it('kid-authenticated create succeeds and is attributed to the kid [PRO-009] [PRO-007]', async () =>
    withApp(async (t) => {
      await t.addProfile('Dad', 'parent')
      const kid = await t.addProfile('Sam', 'kid')
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/profiles',
        headers: asProfile(kid.id),
        payload: { name: 'Bestie', role: 'kid' },
      })
      expect(res.statusCode).toBe(201)

      const { rows } = await t.db.pool.query(
        `SELECT actor_id FROM events WHERE type = 'profile.created' AND payload->>'name' = 'Bestie'`,
      )
      expect(rows[0].actor_id).toBe(kid.id)
    }))

  it('profile updates stay parent-only even while creation is open [PRO-005] [PRO-009]', async () =>
    withApp(async (t) => {
      const dad = await t.addProfile('Dad', 'parent')
      const kid = await t.addProfile('Sam', 'kid')
      const res = await t.app.inject({
        method: 'PATCH',
        url: `/api/profiles/${dad.id}`,
        headers: asProfile(kid.id),
        payload: { name: 'Renamed' },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe('parent_required')
    }))

  it('empty DB: the parent-first bootstrap rule holds regardless of the flag [PRO-008] [PRO-009]', async () =>
    withApp(async (t) => {
      // Open creation never weakens the deadlock guard: a kid-first family would have
      // nobody able to administer anything.
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/profiles',
        payload: { name: 'Sam', role: 'kid' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('validation')
    }))
})
