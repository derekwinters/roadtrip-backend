import type { FastifyInstance } from 'fastify'
import { buildApp, type BuildOptions } from '../../src/app.js'
import { createTestDb, type TestDb } from './db.js'

export interface TestApp {
  app: FastifyInstance
  db: TestDb
  /** Creates a profile directly in the database and returns it. */
  addProfile: (name: string, role: 'parent' | 'kid') => Promise<{ id: string; name: string; role: string }>
  /** Turns open_profile_creation off through the API, as the given parent (PRO-009/CFG-006). */
  closeCreation: (parentId: string) => Promise<void>
  close: () => Promise<void>
}

export interface TestAppOptions {
  /** Geocode proxy injection — tests always stub the upstream (GSR-002/005). */
  geocode?: BuildOptions['geocode']
}

export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const db = await createTestDb()
  const app = await buildApp({ pool: db.pool, geocode: opts.geocode })

  return {
    app,
    db,
    addProfile: async (name, role) => {
      const { rows } = await db.pool.query(
        'INSERT INTO profiles (name, role) VALUES ($1, $2) RETURNING id, name, role',
        [name, role],
      )
      return rows[0]
    },
    closeCreation: async (parentId) => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/config',
        headers: asProfile(parentId),
        payload: { open_profile_creation: false },
      })
      if (res.statusCode !== 200) throw new Error(`closeCreation failed: ${res.statusCode} ${res.body}`)
    },
    close: async () => {
      await app.close()
      await db.drop()
    },
  }
}

/** Convenience for authenticated inject calls. */
export function asProfile(profileId: string): Record<string, string> {
  return { 'x-profile-id': profileId }
}
