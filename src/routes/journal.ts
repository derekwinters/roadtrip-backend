import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireProfile } from '../auth.js'
import { appendEvent } from '../events/store.js'
import { JOURNAL_EVENT_TYPES, renderJournalEntry } from '../journal/render.js'

const querySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
})

const postSchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict()

export async function journalRoutes(app: FastifyInstance): Promise<void> {
  // JRNL-001/002/004/005 — newest-first feed over journal-worthy events, ordered by client_ts.
  app.get('/api/journal', { preHandler: [requireProfile] }, async (req) => {
    const q = querySchema.parse(req.query)
    const args: unknown[] = [Array.from(JOURNAL_EVENT_TYPES)]
    let cursorClause = ''
    if (q.before) {
      args.push(q.before)
      cursorClause = `AND (e.client_ts, e.seq) < (SELECT client_ts, seq FROM events WHERE seq = $${args.length})`
    }
    args.push(q.limit)
    const { rows } = await app.pool.query(
      `SELECT e.*, p.id AS p_id, p.name AS p_name, p.avatar AS p_avatar, p.role AS p_role
       FROM events e LEFT JOIN profiles p ON p.id = e.actor_id
       WHERE e.type = ANY($1) ${cursorClause}
       ORDER BY e.client_ts DESC, e.seq DESC
       LIMIT $${args.length}`,
      args,
    )
    // Game-result texts need winner/loser names (JRNL-006); one cheap prefetch at family scale.
    const profilesById = new Map(
      (await app.pool.query('SELECT id, name, avatar FROM profiles')).rows.map((p) => [
        p.id,
        { name: p.name, avatar: p.avatar },
      ]),
    )
    const entries = rows.map((r) => renderJournalEntry(r, profilesById)).filter((e) => e !== null)
    const nextBefore = rows.length === Number(q.limit) ? Number(rows[rows.length - 1].seq) : null
    return { entries, next_before: nextBefore }
  })

  // JRNL-003 / PRO-006 — instant publishing for every profile, no moderation.
  app.post('/api/journal', { preHandler: [requireProfile] }, async (req, reply) => {
    const body = postSchema.parse(req.body)
    const res = await appendEvent(app.pool, {
      type: 'journal.post',
      actorId: req.profile!.id,
      payload: { text: body.text },
      clientTs: new Date(),
    })
    app.bus.notify()
    const { rows } = await app.pool.query(
      `SELECT e.*, p.id AS p_id, p.name AS p_name, p.avatar AS p_avatar, p.role AS p_role
       FROM events e LEFT JOIN profiles p ON p.id = e.actor_id WHERE e.seq = $1`,
      [res.seq],
    )
    return reply.status(201).send(renderJournalEntry(rows[0]))
  })
}
