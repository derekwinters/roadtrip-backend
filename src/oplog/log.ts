/**
 * Operational log (docs/spec/15-operational-log.md, OPLOG-001..005).
 *
 * A small, durable, OPT-IN record of operational failures, kept outside the events stream.
 * Invariants: it never captures log output or requests wholesale — only an explicit
 * `record` call writes (OPLOG-002) — and a failure to record never reaches the caller,
 * so it can never turn a response into a different error (OPLOG-005).
 */
import type { Db } from '../db.js'
import { getConfig } from '../config.js'

export interface OpLogEntry {
  /** The recording feature, e.g. `geocode`. */
  source: string
  /** A stable machine code, e.g. `geocode_upstream_error`. */
  code: string
  /** Short caller-chosen context, e.g. `{ query, upstream_status }`. */
  detail?: Record<string, unknown>
}

/** Minimal structured logger (satisfied by Fastify's pino logger). */
export interface OpLogLogger {
  warn(obj: unknown, msg: string): void
}

const consoleLogger: OpLogLogger = { warn: (obj, msg) => console.warn(msg, obj) }

export class OperationalLog {
  constructor(
    private readonly db: Db,
    private readonly logger: OpLogLogger = consoleLogger,
  ) {}

  /** Appends one entry, then trims to `operational_log_max_rows` (OPLOG-004). Never throws (OPLOG-005). */
  async record(entry: OpLogEntry): Promise<void> {
    try {
      await this.db.query('INSERT INTO operational_log (source, code, detail) VALUES ($1, $2, $3)', [
        entry.source,
        entry.code,
        JSON.stringify(entry.detail ?? {}),
      ])
      const { operational_log_max_rows: maxRows } = await getConfig(this.db)
      await this.db.query(
        `DELETE FROM operational_log
          WHERE id <= (SELECT id FROM operational_log ORDER BY id DESC OFFSET $1 LIMIT 1)`,
        [maxRows],
      )
    } catch (err) {
      this.logger.warn(
        { source: entry.source, code: entry.code, err: err instanceof Error ? err.message : String(err) },
        'failed to write operational log entry',
      )
    }
  }
}
