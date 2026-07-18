import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireProfile } from '../auth.js'
import { foldBingoCard, type BingoProfile } from '../bingo/card.js'
import { resolveTripScope } from '../trips/scope.js'

const querySchema = z.object({ trip: z.string().uuid().optional() })

/** License Plate Bingo read model (docs/spec/14-bingo.md, BNG-004). */
export async function bingoRoutes(app: FastifyInstance): Promise<void> {
  // BNG-004 — the card, scoped per trip exactly like the other read models (TRIP-007).
  app.get('/api/bingo', { preHandler: [requireProfile] }, async (req) => {
    const q = querySchema.parse(req.query)
    const scope = await resolveTripScope(app.pool, q.trip)
    const args: unknown[] = []
    let scopeClause = ''
    if (scope !== null) {
      args.push(scope)
      scopeClause = `AND trip_id = $${args.length}` // NULL-trip events excluded (TRIP-010)
    }
    const { rows } = await app.pool.query(
      `SELECT seq, type, actor_id, payload, client_ts FROM events
       WHERE type IN ('plate.spotted', 'plate.unspotted') ${scopeClause}
       ORDER BY client_ts, seq`,
      args,
    )
    // Names for credits and removal permissions (BNG-003); one cheap prefetch at family scale.
    const profilesById = new Map<string, BingoProfile>(
      (await app.pool.query('SELECT id, name, role FROM profiles')).rows.map((p: any) => [
        p.id,
        { name: p.name, role: p.role },
      ]),
    )
    return foldBingoCard(rows, profilesById)
  })
}
