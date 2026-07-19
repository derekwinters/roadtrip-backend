/**
 * Address search proxy (docs/spec/13-geocode-search.md, GSR-001..005).
 *
 * Forward geocoding for destination planning — the single, explicitly best-effort
 * ONLINE component of the system (SYS-007 clarification in the spec). Results are
 * cached forever in geocode_cache keyed by the normalized query, so repeat searches
 * work offline and across restarts (GSR-003); upstream calls are throttled to
 * Nominatim's one-request-per-second policy (GSR-005); the upstream fetcher is
 * injectable so tests never call the real service.
 */
import type { Db } from '../db.js'
import { AppError } from '../errors.js'

export interface GeocodeMatch {
  display_name: string
  lat: number
  lon: number
}

export type UpstreamFetcher = (query: string) => Promise<GeocodeMatch[]>

export const MAX_MATCHES = 5
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
export const USER_AGENT = 'roadtrip-backend (self-hosted family app)'
const DEFAULT_MIN_SPACING_MS = 1100 // just over Nominatim's absolute max of 1 req/s (GSR-005)
const DEFAULT_TIMEOUT_MS = 5000

/**
 * Thrown by an upstream fetcher when the upstream was *reached* but answered with an error
 * (a non-2xx HTTP status, or a 2xx with an unusable body). Carries the offending HTTP status
 * so the failure can be signalled and logged distinctly from a genuine unreachable/offline
 * upstream (GSR-006). A fetcher that cannot reach upstream at all throws the raw fetch error
 * (network error / DNS failure / timeout), which is treated as `geocode_unavailable` (GSR-004).
 */
export class UpstreamGeocodeError extends Error {
  constructor(
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? `Upstream geocoder responded ${status}`)
    this.name = 'UpstreamGeocodeError'
  }
}

// GSR-004: the server could not reach the upstream at all — treat as offline.
const geocodeUnavailable = () =>
  new AppError(503, 'geocode_unavailable', 'Address search is unavailable (upstream unreachable and query not cached)')

// GSR-006: the upstream was reached but returned an error — distinct from offline, carries the status.
const geocodeUpstreamError = (status: number) =>
  new AppError(
    503,
    'geocode_upstream_error',
    `Address search is temporarily unavailable (upstream returned HTTP ${status})`,
  )

/** Minimal structured logger (satisfied by Fastify's pino logger). Injected for diagnosability. */
export interface GeocodeLogger {
  warn(obj: unknown, msg: string): void
}

const consoleLogger: GeocodeLogger = {
  warn: (obj, msg) => console.warn(msg, obj),
}

/**
 * Serializes tasks with >= minSpacingMs between successive task STARTS (GSR-005).
 * Tasks run strictly one at a time; a rejected task neither wedges the queue nor
 * resets the spacing. Clock and sleep are injectable for deterministic tests.
 */
export class ThrottleQueue {
  private chain: Promise<unknown> = Promise.resolve()
  private lastStart: number | null = null

  constructor(
    private readonly minSpacingMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(async () => {
      if (this.lastStart !== null) {
        const wait = this.lastStart + this.minSpacingMs - this.now()
        if (wait > 0) await this.sleep(wait)
      }
      this.lastStart = this.now()
      return fn()
    })
    this.chain = task.catch(() => undefined) // keep the chain alive past failures
    return task
  }
}

export interface NominatimOptions {
  baseUrl?: string
  userAgent?: string
  timeoutMs?: number
  /** Injectable for tests — the suite never calls the real Nominatim. */
  fetchImpl?: typeof fetch
}

interface NominatimRow {
  display_name?: unknown
  lat?: unknown
  lon?: unknown
}

/**
 * Default upstream: Nominatim search with format=jsonv2, limit 5, and the descriptive
 * User-Agent the usage policy requires (GSR-002). Rows are reduced to numeric
 * {display_name, lat, lon} matches.
 */
export function nominatimFetcher(opts: NominatimOptions = {}): UpstreamFetcher {
  const baseUrl = opts.baseUrl ?? NOMINATIM_URL
  const userAgent = opts.userAgent ?? USER_AGENT
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetchImpl ?? fetch
  return async (query) => {
    const url = new URL(baseUrl)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('limit', String(MAX_MATCHES))
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new UpstreamGeocodeError(res.status) // reached but refused (403/429/5xx) — GSR-006
    const rows = (await res.json()) as NominatimRow[]
    if (!Array.isArray(rows)) throw new UpstreamGeocodeError(res.status, 'Nominatim returned a non-array response')
    return rows.slice(0, MAX_MATCHES).map((row) => ({
      display_name: String(row.display_name ?? ''),
      lat: Number(row.lat),
      lon: Number(row.lon),
    }))
  }
}

export interface GeocodeSearchOptions {
  /** Upstream fetcher; tests inject a stub (default: real Nominatim, GSR-002). */
  fetcher?: UpstreamFetcher
  /** Minimum ms between upstream call starts (default 1100, GSR-005). */
  minSpacingMs?: number
  /** Structured logger for upstream failures (default: console). Wire Fastify's log here. */
  logger?: GeocodeLogger
}

/** Cache key normalization: trimmed, whitespace-collapsed, lower-cased (GSR-003). */
export function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, ' ').toLowerCase()
}

export class GeocodeSearch {
  private readonly fetcher: UpstreamFetcher
  private readonly queue: ThrottleQueue
  private readonly logger: GeocodeLogger
  /** Concurrent identical queries share one upstream call (GSR-003/005). */
  private readonly inflight = new Map<string, Promise<GeocodeMatch[]>>()

  constructor(
    private readonly db: Db,
    opts: GeocodeSearchOptions = {},
  ) {
    this.fetcher = opts.fetcher ?? nominatimFetcher()
    this.queue = new ThrottleQueue(opts.minSpacingMs ?? DEFAULT_MIN_SPACING_MS)
    this.logger = opts.logger ?? consoleLogger
  }

  async search(rawQuery: string): Promise<GeocodeMatch[]> {
    const query = normalizeQuery(rawQuery)
    const cached = await this.readCache(query) // GSR-003: cache first, upstream never re-hit
    if (cached) return cached
    const existing = this.inflight.get(query)
    if (existing) return existing
    const pending = this.queue
      .run(() => this.fetchAndCache(query))
      .finally(() => this.inflight.delete(query))
    this.inflight.set(query, pending)
    return pending
  }

  private async readCache(query: string): Promise<GeocodeMatch[] | null> {
    const { rows } = await this.db.query('SELECT results FROM geocode_cache WHERE query = $1', [query])
    return rows.length === 1 ? (rows[0].results as GeocodeMatch[]) : null
  }

  private async fetchAndCache(query: string): Promise<GeocodeMatch[]> {
    let matches: GeocodeMatch[]
    try {
      matches = (await this.fetcher(query)).slice(0, MAX_MATCHES)
    } catch (err) {
      // Never cache a failure. Distinguish egress-blocked (unreachable) from upstream-blocked
      // (reached but refused) so operators and the client can react appropriately (GSR-004/006).
      if (err instanceof UpstreamGeocodeError) {
        this.logger.warn(
          { query, upstreamStatus: err.status, err: err.message },
          'geocode upstream returned an error status',
        )
        throw geocodeUpstreamError(err.status) // GSR-006
      }
      this.logger.warn(
        { query, err: err instanceof Error ? err.message : String(err) },
        'geocode upstream unreachable',
      )
      throw geocodeUnavailable() // GSR-004
    }
    await this.db.query(
      `INSERT INTO geocode_cache (query, results, fetched_at) VALUES ($1, $2, now())
       ON CONFLICT (query) DO UPDATE SET results = EXCLUDED.results, fetched_at = now()`,
      [query, JSON.stringify(matches)],
    )
    return matches
  }
}
