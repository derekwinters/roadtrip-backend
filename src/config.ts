import type { Db } from './db.js'
import { validation } from './errors.js'
import { GAME_TYPES, type GameType } from './games/registry.js'

/** Family-wide game-type switch key for one game type (CFG-010). */
export type GameEnabledKey = `game_${GameType}_enabled`

export function gameEnabledKey(type: GameType): GameEnabledKey {
  return `game_${type}_enabled`
}

/**
 * Per-type defaults for the family-wide switches (CFG-010). Typed as a Record over GameType,
 * so adding a game type without a default fails typecheck; the config keys are derived from
 * this map and therefore can never drift from GAME_TYPES (CFG-010 invariant).
 */
const GAME_ENABLED_DEFAULTS: Record<GameType, boolean> = {
  chess: true,
  checkers: true,
  tictactoe: true,
  ultimate: true,
  hangman: true,
  fourinarow: true,
  dotsandboxes: true,
}

const GAME_ENABLED_KEYS: GameEnabledKey[] = GAME_TYPES.map(gameEnabledKey)

/** Tunable parameters — defaults and bounds are normative in docs/spec/05-config.md. */
interface BaseConfig {
  ping_interval_s: number
  stop_radius_m: number
  min_stop_duration_min: number
  arrival_radius_m: number
  city_radius_km: number
  city_min_population: number
  track_cities_through: boolean
  track_cities_stopped: boolean
  operational_log_max_rows: number
  stop_label_max_chars: number
  open_profile_creation: boolean
}

/** Every config key: the scalar tunables plus one switch per game type (CFG-010). */
export type AppConfig = BaseConfig & Record<GameEnabledKey, boolean>

/** Boolean behavior flags (CFG-006, CFG-009, CFG-010). */
type BooleanConfigKey = 'open_profile_creation' | 'track_cities_through' | 'track_cities_stopped' | GameEnabledKey

/** Numeric tunables, bounded below; boolean flags are typed by BOOLEAN_KEYS. */
type NumericConfigKey = Exclude<keyof AppConfig, BooleanConfigKey>

export const CONFIG_DEFAULTS: AppConfig = {
  ping_interval_s: 300,
  stop_radius_m: 100,
  min_stop_duration_min: 10,
  arrival_radius_m: 800,
  city_radius_km: 15,
  city_min_population: 5000,
  track_cities_through: true,
  track_cities_stopped: true,
  operational_log_max_rows: 1000,
  stop_label_max_chars: 80,
  open_profile_creation: true,
  ...(Object.fromEntries(GAME_TYPES.map((t) => [gameEnabledKey(t), GAME_ENABLED_DEFAULTS[t]])) as Record<
    GameEnabledKey,
    boolean
  >),
}

export const CONFIG_BOUNDS: Record<NumericConfigKey, [number, number]> = {
  ping_interval_s: [5, 3600],
  stop_radius_m: [20, 1000],
  min_stop_duration_min: [1, 240],
  arrival_radius_m: [100, 5000],
  city_radius_km: [1, 50],
  city_min_population: [0, 10_000_000],
  operational_log_max_rows: [1, 100000],
  stop_label_max_chars: [1, 2000],
}

const BOOLEAN_KEYS = new Set<keyof AppConfig>([
  'open_profile_creation',
  'track_cities_through',
  'track_cities_stopped',
  ...GAME_ENABLED_KEYS,
])

/** Numeric keys that must be whole numbers (CFG-007, CFG-008, CFG-009). */
const INTEGER_KEYS = new Set<keyof AppConfig>(['operational_log_max_rows', 'stop_label_max_chars', 'city_min_population'])

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
    if (!(row.key in cfg)) continue
    const out = cfg as Record<string, number | boolean>
    // JSONB scalars come back typed; tolerate legacy stringified values either way.
    out[row.key] = BOOLEAN_KEYS.has(row.key as keyof AppConfig)
      ? row.value === true || row.value === 'true'
      : Number(row.value)
  }
  return cfg
}

/**
 * Validates a partial config object against known keys and bounds. Throws `validation`
 * without applying anything when any entry is invalid (CFG-002).
 */
export function validateConfigPatch(patch: Record<string, unknown>): Partial<AppConfig> {
  const out: Record<string, number | boolean> = {}
  const entries = Object.entries(patch)
  if (entries.length === 0) throw validation('Empty config update')
  for (const [key, raw] of entries) {
    if (BOOLEAN_KEYS.has(key as keyof AppConfig)) {
      if (typeof raw !== 'boolean') throw validation(`${key} must be a boolean`)
      out[key] = raw
      continue
    }
    const bounds = CONFIG_BOUNDS[key as NumericConfigKey]
    if (!bounds) throw validation(`Unknown config key: ${key}`)
    const value = typeof raw === 'number' ? raw : NaN
    if (!Number.isFinite(value) || value < bounds[0] || value > bounds[1]) {
      throw validation(`${key} must be a number in [${bounds[0]}, ${bounds[1]}]`)
    }
    if (INTEGER_KEYS.has(key as keyof AppConfig) && !Number.isInteger(value)) {
      throw validation(`${key} must be an integer`)
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
