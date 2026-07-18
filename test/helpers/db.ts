import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { createPool, migrate } from '../../src/db.js'
import { seedConfigDefaults } from '../../src/config.js'

/**
 * Integration-test database harness: every call creates a brand-new database on the test
 * server (local cluster or CI service container), runs migrations, and seeds config defaults.
 */
const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://roadtrip@127.0.0.1:5433/postgres'

export interface TestDb {
  pool: pg.Pool
  url: string
  drop: () => Promise<void>
}

export async function createTestDb(): Promise<TestDb> {
  const name = `roadtrip_test_${randomBytes(6).toString('hex')}`
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 })
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()

  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`)
  const pool = createPool(url)
  await migrate(pool)
  await seedConfigDefaults(pool)

  return {
    pool,
    url,
    drop: async () => {
      await pool.end()
      const admin2 = new pg.Pool({ connectionString: ADMIN_URL, max: 1 })
      await admin2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin2.end()
    },
  }
}
