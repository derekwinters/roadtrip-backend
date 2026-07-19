import { describe, it, expect } from 'vitest'
import { ThrottleQueue, nominatimFetcher, UpstreamGeocodeError } from '../../src/geocode/search.js'

/** Deterministic virtual clock: sleep() advances time instantly. */
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('geocode throttle queue', () => {
  it('spaces upstream call starts >= minSpacing apart [GSR-005]', async () => {
    const clock = fakeClock()
    const q = new ThrottleQueue(1000, clock.now, clock.sleep)
    const starts: number[] = []
    await Promise.all([
      q.run(async () => starts.push(clock.now())),
      q.run(async () => starts.push(clock.now())),
      q.run(async () => starts.push(clock.now())),
    ])
    expect(starts).toEqual([0, 1000, 2000])
  })

  it('concurrent tasks queue instead of running in parallel [GSR-005]', async () => {
    const clock = fakeClock()
    const q = new ThrottleQueue(50, clock.now, clock.sleep)
    let active = 0
    let maxActive = 0
    const task = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve() // yield while "in flight"
      active -= 1
      return 'done'
    }
    const results = await Promise.all([q.run(task), q.run(task), q.run(task), q.run(task)])
    expect(maxActive).toBe(1)
    expect(results).toEqual(['done', 'done', 'done', 'done'])
  })

  it('does not over-throttle after an idle gap longer than the spacing [GSR-005]', async () => {
    const clock = fakeClock()
    const q = new ThrottleQueue(1000, clock.now, clock.sleep)
    const starts: number[] = []
    await q.run(async () => starts.push(clock.now()))
    clock.advance(2500) // idle well past the spacing window
    await q.run(async () => starts.push(clock.now()))
    expect(starts).toEqual([0, 2500]) // second starts immediately, no extra wait
  })

  it('a rejecting task neither wedges the queue nor skips the spacing [GSR-005]', async () => {
    const clock = fakeClock()
    const q = new ThrottleQueue(1000, clock.now, clock.sleep)
    const boom = q.run(async () => {
      throw new Error('upstream down')
    })
    const next = q.run(async () => clock.now())
    await expect(boom).rejects.toThrow('upstream down')
    await expect(next).resolves.toBe(1000)
  })
})

describe('default Nominatim fetcher', () => {
  const nominatimRow = (name: string, lat: string, lon: string) => ({
    place_id: 42,
    display_name: name,
    lat,
    lon,
    category: 'place',
  })

  it('requests jsonv2 with limit 5 and the descriptive User-Agent, mapping rows to numeric matches [GSR-002]', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
      return {
        ok: true,
        status: 200,
        json: async () => [nominatimRow('Denver, Colorado, United States', '39.7392', '-104.9849')],
      } as Response
    }) as typeof fetch

    const fetcher = nominatimFetcher({ fetchImpl })
    const matches = await fetcher('Denver, CO')

    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!.url)
    expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search')
    expect(url.searchParams.get('q')).toBe('Denver, CO')
    expect(url.searchParams.get('format')).toBe('jsonv2')
    expect(url.searchParams.get('limit')).toBe('5')
    expect(calls[0]!.headers['User-Agent']).toBe('roadtrip-backend (self-hosted family app)')
    expect(matches).toEqual([
      { display_name: 'Denver, Colorado, United States', lat: 39.7392, lon: -104.9849 },
    ])
  })

  it('caps results at 5 even if upstream returns more [GSR-002]', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => nominatimRow(`Match ${i}`, `${40 + i}`, `${-100 - i}`))
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, json: async () => rows }) as Response) as typeof fetch
    const fetcher = nominatimFetcher({ fetchImpl })
    const matches = await fetcher('main street')
    expect(matches).toHaveLength(5)
    expect(matches[0]).toEqual({ display_name: 'Match 0', lat: 40, lon: -100 })
  })

  it('throws a typed UpstreamGeocodeError carrying the HTTP status on non-2xx [GSR-006]', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 429, json: async () => ({}) }) as Response) as typeof fetch
    const fetcher = nominatimFetcher({ fetchImpl })
    const err = await fetcher('anywhere').catch((e) => e)
    expect(err).toBeInstanceOf(UpstreamGeocodeError)
    expect((err as UpstreamGeocodeError).status).toBe(429)
    expect(String(err)).toMatch(/429/)
  })

  it('treats a reached-but-unusable (non-array) body as an upstream error [GSR-006]', async () => {
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, json: async () => ({ not: 'an array' }) }) as Response) as typeof fetch
    const fetcher = nominatimFetcher({ fetchImpl })
    const err = await fetcher('anywhere').catch((e) => e)
    expect(err).toBeInstanceOf(UpstreamGeocodeError)
    expect((err as UpstreamGeocodeError).status).toBe(200)
  })

  it('propagates the raw fetch error (unreachable) without wrapping it as an upstream error [GSR-004]', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const fetcher = nominatimFetcher({ fetchImpl })
    const err = await fetcher('anywhere').catch((e) => e)
    expect(err).not.toBeInstanceOf(UpstreamGeocodeError)
    expect(String(err)).toMatch(/fetch failed/)
  })
})
