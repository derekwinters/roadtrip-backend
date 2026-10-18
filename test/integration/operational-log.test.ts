import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import { OperationalLog } from '../../src/oplog/log.js'
import { applyConfigChanges } from '../../src/config.js'
import type { GeocodeMatch, UpstreamFetcher } from '../../src/geocode/search.js'
import { UpstreamGeocodeError } from '../../src/geocode/search.js'

/**
 * Operational log (docs/spec/15-operational-log.md) and its first user, geocode failures
 * (docs/spec/13-geocode-search.md, GSR-007). The geocode upstream is ALWAYS a stub.
 */

const silent = { warn: () => undefined }

const rowsOf = async (t: TestApp) =>
  (await t.db.pool.query('SELECT id, recorded_at, source, code, detail FROM operational_log ORDER BY id')).rows

describe('operational log facility', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(async () => await t.close())

  it('lives in its own table outside the events stream [OPLOG-001]', async () => {
    const { rows: before } = await t.db.pool.query('SELECT count(*)::int AS n FROM events')
    await new OperationalLog(t.db.pool, silent).record({ source: 'test', code: 'probe', detail: {} })
    const { rows: after } = await t.db.pool.query('SELECT count(*)::int AS n FROM events')
    expect(after[0].n).toBe(before[0].n) // no event appended
    expect(await rowsOf(t)).toHaveLength(1)
    await t.db.pool.query('DELETE FROM operational_log')
  })

  it('stores timestamp, source, code and detail, read back directly from the database [OPLOG-003]', async () => {
    const start = Date.now()
    await new OperationalLog(t.db.pool, silent).record({
      source: 'geocode',
      code: 'geocode_upstream_error',
      detail: { query: 'denver', upstream_status: 429 },
    })
    const rows = await rowsOf(t)
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('geocode')
    expect(rows[0].code).toBe('geocode_upstream_error')
    expect(rows[0].detail).toEqual({ query: 'denver', upstream_status: 429 })
    expect(rows[0].recorded_at).toBeInstanceOf(Date)
    expect(Math.abs((rows[0].recorded_at as Date).getTime() - start)).toBeLessThan(60_000)
    await t.db.pool.query('DELETE FROM operational_log')
  })

  it('is opt-in: ordinary and failing requests write nothing [OPLOG-002]', async () => {
    const parent = await t.addProfile('Dad', 'parent')
    const kid = await t.addProfile('Sam', 'kid')
    const reqs = [
      t.app.inject({ method: 'GET', url: '/api/health' }),
      t.app.inject({ method: 'GET', url: '/api/config', headers: asProfile(kid.id) }),
      t.app.inject({ method: 'GET', url: '/api/no-such-route' }), // 404
      t.app.inject({ method: 'PUT', url: '/api/config', headers: asProfile(parent.id), payload: { nope: 1 } }), // 400
      t.app.inject({ method: 'GET', url: '/api/geocode?q=x', headers: asProfile(kid.id) }), // 403
    ]
    const res = await Promise.all(reqs)
    expect(res.map((r) => r.statusCode)).toEqual([200, 200, 404, 400, 403])
    expect(await rowsOf(t)).toHaveLength(0)
  })

  it('keeps at most operational_log_max_rows entries, removing the oldest [OPLOG-004] [CFG-007]', async () => {
    await applyConfigChanges(t.db.pool, { operational_log_max_rows: 3 })
    const log = new OperationalLog(t.db.pool, silent)
    for (let i = 1; i <= 4; i++) await log.record({ source: 'test', code: `entry_${i}`, detail: { i } })
    const rows = await rowsOf(t)
    expect(rows.map((r) => r.code)).toEqual(['entry_2', 'entry_3', 'entry_4']) // N kept, oldest gone
    await applyConfigChanges(t.db.pool, { operational_log_max_rows: 1000 })
    await t.db.pool.query('DELETE FROM operational_log')
  })
})

describe('operational_log_max_rows config key', () => {
  let t: TestApp
  let parent: { id: string }
  beforeAll(async () => {
    t = await createTestApp()
    parent = await t.addProfile('Mom', 'parent')
  })
  afterAll(async () => await t.close())

  const put = (payload: Record<string, unknown>, profileId = parent.id) =>
    t.app.inject({ method: 'PUT', url: '/api/config', headers: asProfile(profileId), payload })

  it('defaults to 1000, is parent-changeable, and rejects non-integer/out-of-bounds values [CFG-007]', async () => {
    const read = await t.app.inject({ method: 'GET', url: '/api/config', headers: asProfile(parent.id) })
    expect(read.json().operational_log_max_rows).toBe(1000)

    for (const bad of [0, 100001, 2.5, '10']) {
      const res = await put({ operational_log_max_rows: bad })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('validation')
    }

    const kid = await t.addProfile('Kim', 'kid')
    expect((await put({ operational_log_max_rows: 50 }, kid.id)).statusCode).toBe(403)

    const ok = await put({ operational_log_max_rows: 50 })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().operational_log_max_rows).toBe(50)
  })
})

describe('geocode failures in the operational log', () => {
  const MATCH: GeocodeMatch[] = [{ display_name: 'Denver, Colorado, United States', lat: 39.74, lon: -104.99 }]

  async function appWith(fetcher: UpstreamFetcher) {
    const t = await createTestApp({ geocode: { fetcher, minSpacingMs: 1 } })
    const parent = await t.addProfile('Pat', 'parent')
    const search = (q: string) =>
      t.app.inject({ method: 'GET', url: `/api/geocode?q=${encodeURIComponent(q)}`, headers: asProfile(parent.id) })
    return { t, search }
  }

  it('an upstream 429 → 503 geocode_upstream_error and one row carrying the status [GSR-007]', async () => {
    const { t, search } = await appWith(async () => {
      throw new UpstreamGeocodeError(429)
    })
    try {
      const res = await search('  Denver  ')
      expect(res.statusCode).toBe(503)
      expect(res.json().error.code).toBe('geocode_upstream_error')
      const rows = await rowsOf(t)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        source: 'geocode',
        code: 'geocode_upstream_error',
        detail: { query: 'denver', upstream_status: 429 },
      })
    } finally {
      await t.close()
    }
  })

  it('a network error → 503 geocode_unavailable and one row [GSR-007]', async () => {
    const { t, search } = await appWith(async () => {
      throw new Error('getaddrinfo ENOTFOUND nominatim.openstreetmap.org')
    })
    try {
      const res = await search('Boise')
      expect(res.statusCode).toBe(503)
      expect(res.json().error.code).toBe('geocode_unavailable')
      const rows = await rowsOf(t)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ source: 'geocode', code: 'geocode_unavailable', detail: { query: 'boise' } })
    } finally {
      await t.close()
    }
  })

  it('a successful lookup and a cache hit record nothing [GSR-007]', async () => {
    const { t, search } = await appWith(async () => MATCH)
    try {
      expect((await search('Denver')).statusCode).toBe(200) // upstream success
      expect((await search('denver')).statusCode).toBe(200) // cache hit
      expect(await rowsOf(t)).toHaveLength(0)
    } finally {
      await t.close()
    }
  })

  it('a log-table write failure still returns the normal geocode response [GSR-007] [OPLOG-005]', async () => {
    const { t, search } = await appWith(async () => {
      throw new UpstreamGeocodeError(429)
    })
    try {
      await t.db.pool.query('DROP TABLE operational_log') // every write now fails
      const res = await search('Denver')
      expect(res.statusCode).toBe(503)
      expect(res.json().error.code).toBe('geocode_upstream_error') // not 500, not a different code
      expect(res.json().error.message).toMatch(/429/)
    } finally {
      await t.close()
    }
  })
})
