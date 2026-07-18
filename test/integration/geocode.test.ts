import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../src/app.js'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'
import type { GeocodeMatch, UpstreamFetcher } from '../../src/geocode/search.js'

/**
 * Address search proxy (docs/spec/13-geocode-search.md, GSR-001..005). The upstream is
 * ALWAYS a stub here — the suite never calls the real Nominatim.
 */

function makeStub(results: GeocodeMatch[]) {
  const state = {
    calls: [] as Array<{ query: string; at: number }>,
    active: 0,
    maxActive: 0,
    fail: false,
    results,
  }
  const fetcher: UpstreamFetcher = async (query) => {
    state.active += 1
    state.maxActive = Math.max(state.maxActive, state.active)
    state.calls.push({ query, at: Date.now() })
    await new Promise((r) => setTimeout(r, 5)) // hold the upstream slot to expose overlap
    state.active -= 1
    if (state.fail) throw new Error('upstream unreachable')
    return state.results
  }
  return { state, fetcher }
}

const SEVEN_MATCHES: GeocodeMatch[] = Array.from({ length: 7 }, (_, i) => ({
  display_name: `Springfield ${i}, United States`,
  lat: 39 + i,
  lon: -89 - i,
}))

let t: TestApp
let stub: ReturnType<typeof makeStub>
let parent: { id: string }
let kid: { id: string }

beforeAll(async () => {
  stub = makeStub(SEVEN_MATCHES)
  t = await createTestApp({ geocode: { fetcher: stub.fetcher, minSpacingMs: 1 } })
  parent = await t.addProfile('Dad', 'parent')
  kid = await t.addProfile('Sam', 'kid')
})
afterAll(async () => await t.close())

const search = (q: string, profileId?: string) =>
  t.app.inject({
    method: 'GET',
    url: `/api/geocode?q=${encodeURIComponent(q)}`,
    headers: profileId ? asProfile(profileId) : undefined,
  })

describe('geocode address search proxy', () => {
  it('is parent-only: kid → 403 parent_required, missing profile → 401, q required [GSR-001]', async () => {
    const denied = await search('Denver', kid.id)
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('parent_required')

    const anon = await search('Denver')
    expect(anon.statusCode).toBe(401)
    expect(anon.json().error.code).toBe('unauthenticated')

    const noQuery = await t.app.inject({
      method: 'GET',
      url: '/api/geocode',
      headers: asProfile(parent.id),
    })
    expect(noQuery.statusCode).toBe(400)

    expect(stub.state.calls).toHaveLength(0) // none of the rejections reached upstream
  })

  it('proxies the stubbed upstream and returns at most 5 numeric matches [GSR-002]', async () => {
    const res = await search('Springfield', parent.id)
    expect(res.statusCode).toBe(200)
    const matches = res.json()
    expect(Array.isArray(matches)).toBe(true)
    expect(matches).toHaveLength(5) // stub returned 7; response is capped
    expect(matches).toEqual(SEVEN_MATCHES.slice(0, 5))
    for (const m of matches) {
      expect(typeof m.display_name).toBe('string')
      expect(typeof m.lat).toBe('number')
      expect(typeof m.lon).toBe('number')
    }
    expect(stub.state.calls).toHaveLength(1)
    expect(stub.state.calls[0]!.query).toBe('springfield') // normalized query goes upstream
  })

  it('identical queries are served from the persistent cache without re-calling upstream [GSR-003]', async () => {
    const upstreamCallsBefore = stub.state.calls.length
    const res = await search('  SPRINGFIELD ', parent.id) // same query after normalization
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(SEVEN_MATCHES.slice(0, 5))
    expect(stub.state.calls.length).toBe(upstreamCallsBefore) // cache hit, no upstream call

    const { rows } = await t.db.pool.query('SELECT query FROM geocode_cache')
    expect(rows.map((r) => r.query)).toContain('springfield')
  })

  it('cache survives a restart and keeps serving after connectivity loss [GSR-003] [GSR-004]', async () => {
    // "Restart": a fresh app over the same database, whose upstream is dead.
    const offline: UpstreamFetcher = async () => {
      throw new Error('no internet')
    }
    const app2 = await buildApp({ pool: t.db.pool, geocode: { fetcher: offline, minSpacingMs: 1 } })
    try {
      const cached = await app2.inject({
        method: 'GET',
        url: '/api/geocode?q=springfield',
        headers: asProfile(parent.id),
      })
      expect(cached.statusCode).toBe(200)
      expect(cached.json()).toEqual(SEVEN_MATCHES.slice(0, 5))

      const miss = await app2.inject({
        method: 'GET',
        url: '/api/geocode?q=atlantis',
        headers: asProfile(parent.id),
      })
      expect(miss.statusCode).toBe(503)
      expect(miss.json().error.code).toBe('geocode_unavailable')
    } finally {
      await app2.close()
    }
  })

  it('upstream failure without a cache hit → 503 geocode_unavailable, and the failure is not cached [GSR-004]', async () => {
    stub.state.fail = true
    const down = await search('Boise', parent.id)
    expect(down.statusCode).toBe(503)
    expect(down.json().error.code).toBe('geocode_unavailable')

    stub.state.fail = false
    const up = await search('Boise', parent.id) // retried for real: the failure was not cached
    expect(up.statusCode).toBe(200)
    expect(up.json()).toEqual(SEVEN_MATCHES.slice(0, 5))
    expect(stub.state.calls.filter((c) => c.query === 'boise')).toHaveLength(2)
  })

  it('concurrent identical queries share a single upstream call [GSR-003] [GSR-005]', async () => {
    const [a, b] = await Promise.all([search('Duluth', parent.id), search('duluth', parent.id)])
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    expect(a.json()).toEqual(b.json())
    expect(stub.state.calls.filter((c) => c.query === 'duluth')).toHaveLength(1)
  })

  it('upstream calls are spaced >= the configured minimum and never run in parallel [GSR-005]', async () => {
    const throttled = makeStub(SEVEN_MATCHES.slice(0, 1))
    const t2 = await createTestApp({ geocode: { fetcher: throttled.fetcher, minSpacingMs: 250 } })
    try {
      const p2 = await t2.addProfile('Mom', 'parent')
      const q = (text: string) =>
        t2.app.inject({
          method: 'GET',
          url: `/api/geocode?q=${encodeURIComponent(text)}`,
          headers: asProfile(p2.id),
        })
      const results = await Promise.all([q('first query'), q('second query'), q('third query')])
      for (const r of results) expect(r.statusCode).toBe(200)

      const at = throttled.state.calls.map((c) => c.at).sort((x, y) => x - y)
      expect(at).toHaveLength(3)
      expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(200) // 250ms spacing with scheduling slack
      expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(200)
      expect(throttled.state.maxActive).toBe(1) // queued, never parallel
    } finally {
      await t2.close()
    }
  })
})
