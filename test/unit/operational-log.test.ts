import { describe, it, expect } from 'vitest'
import type { Db } from '../../src/db.js'
import { OperationalLog } from '../../src/oplog/log.js'

/** Operational log (docs/spec/15-operational-log.md) — best-effort recording without a database. */

function capturingLogger() {
  const warnings: Array<{ obj: unknown; msg: string }> = []
  return { warnings, logger: { warn: (obj: unknown, msg: string) => warnings.push({ obj, msg }) } }
}

describe('operational log recording', () => {
  it('never throws when the database write fails, and reports it to the process log [OPLOG-005]', async () => {
    const failingDb = {
      query: async () => {
        throw new Error('relation "operational_log" does not exist')
      },
    } as unknown as Db
    const { warnings, logger } = capturingLogger()
    const log = new OperationalLog(failingDb, logger)

    await expect(log.record({ source: 'geocode', code: 'geocode_unavailable', detail: { query: 'x' } })).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.msg).toMatch(/operational log/i)
  })
})
