import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { createTestDb, type TestDb } from './db.js'

export interface TestApp {
  app: FastifyInstance
  db: TestDb
  /** Creates a profile directly in the database and returns it. */
  addProfile: (name: string, role: 'parent' | 'kid') => Promise<{ id: string; name: string; role: string }>
  close: () => Promise<void>
}

export async function createTestApp(): Promise<TestApp> {
  const db = await createTestDb()
  const app = await buildApp({ pool: db.pool })

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
