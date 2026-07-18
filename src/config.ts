import type { Db } from './db.js'
import { validation } from './errors.js'

/** Tunable parameters — defaults and bounds are normative in docs/spec/05-config.md. */
export interface AppConfig {
  ping_interval_s: number
  stop_radius_m: number
  min_stop_duration_min: number
  arrival_radius_m: number
  city_radius_km: number
}

export const CONFIG_DEFAULTS: AppConfig = {
  ping_interval_s: 300,
  stop_radius_m: 100,
  min_stop_duration_min: 10,
  arrival_radius_m: 800,
  city_radius_km: 10,
}

export const CONFIG_BOUNDS: Record<keyof AppConfig, [number, number]> = {
  ping_interval_s: [5, 3600],
  stop_radius_m: [20, 1000],
  min_stop_duration_min: [1, 240],
  arrival_radius_m: [100, 5000],
  city_radius_km: [1, 50],
}

/** Seeds any missing keys with defaults; self-heals on boot (CFG-005). */
export async function seedConfigDefaults(db: Db): Promise<void> {
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    await db.query(
      'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, JSON.stringify(value)],
    )
  }
}

export async function getConfig(db: Db): Promise<AppConfig> {
  const { rows } = await db.query('SELECT key, value FROM config')
  const cfg = { ...CONFIG_DEFAULTS }
  for (const row of rows) {
    if (row.key in cfg) (cfg as Record<string, number>)[row.key] = Number(row.value)
  }
  return cfg
}

/**
 * Validates a partial config object against known keys and bounds. Throws `validation`
 * without applying anything when any entry is invalid (CFG-002).
 */
export function validateConfigPatch(patch: Record<string, unknown>): Partial<AppConfig> {
  const out: Record<string, number> = {}
  const entries = Object.entries(patch)
  if (entries.length === 0) throw validation('Empty config update')
  for (const [key, raw] of entries) {
    const bounds = CONFIG_BOUNDS[key as keyof AppConfig]
    if (!bounds) throw validation(`Unknown config key: ${key}`)
    const value = typeof raw === 'number' ? raw : NaN
    if (!Number.isFinite(value) || value < bounds[0] || value > bounds[1]) {
      throw validation(`${key} must be a number in [${bounds[0]}, ${bounds[1]}]`)
    }
    out[key] = value
  }
  return out as Partial<AppConfig>
}

export async function applyConfigChanges(db: Db, changes: Partial<AppConfig>): Promise<void> {
  for (const [key, value] of Object.entries(changes)) {
    await db.query(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    )
  }
}
