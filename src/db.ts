import pg from 'pg'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export type Db = pg.Pool | pg.PoolClient

export function createPool(connectionString?: string): pg.Pool {
  return new pg.Pool({
    connectionString:
      connectionString ??
      process.env.DATABASE_URL ??
      'postgres://roadtrip:roadtrip@localhost:5432/roadtrip',
    max: 10,
  })
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/** Applies pending SQL migrations in filename order. Idempotent across restarts (SYS-004). */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  )
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const file of files) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rowCount } = await client.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1 FOR UPDATE',
        [file],
      )
      if (rowCount === 0) {
        await client.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'))
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        applied.push(file)
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
  return applied
}
