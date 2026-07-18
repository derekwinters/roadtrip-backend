import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireParent } from '../auth.js'
import { appendEvent } from '../events/store.js'
import { notFound, parentRequired, unauthenticated, validation } from '../errors.js'

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    avatar: z.string().min(1).max(16).default('🙂'),
    role: z.enum(['parent', 'kid']),
  })
  .strict()

const updateSchema = createSchema.partial()

/** Serializes first-run bootstrap creates so exactly one can win the race (PRO-008). */
const BOOTSTRAP_LOCK_KEY = 0x70726f66 // "prof"

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  // PRO-001 — unauthenticated: this is the login screen datasource.
  app.get('/api/profiles', async () => {
    const { rows } = await app.pool.query(
      'SELECT id, name, avatar, role FROM profiles ORDER BY created_at',
    )
    return rows
  })

  // PRO-002 / PRO-007, plus the PRO-008 first-run bootstrap when unauthenticated.
  app.post('/api/profiles', async (req, reply) => {
    // PRO-008 — with no authenticated profile, creation is allowed only while the
    // profiles table is empty, and only for a parent. The emptiness check and the
    // insert share one transaction serialized by an advisory lock, so concurrent
    // bootstrap attempts cannot both observe an empty table (race-safe first create).
    if (!req.profile) {
      const client = await app.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY])
        const { rows: count } = await client.query('SELECT COUNT(*)::int AS n FROM profiles')
        // PRO-008: the refusal must say profiles exist — the generic missing-profile
        // message sends first-run clients chasing their own identity handling.
        if (count[0].n > 0) {
          throw unauthenticated('Profiles already exist — sign in as a parent to add more')
        }
        const body = createSchema.parse(req.body)
        if (body.role !== 'parent') throw validation('The first profile must have the parent role')
        const { rows } = await client.query(
          'INSERT INTO profiles (name, avatar, role) VALUES ($1, $2, $3) RETURNING id, name, avatar, role',
          [body.name, body.avatar, body.role],
        )
        const profile = rows[0]
        await appendEvent(client, {
          type: 'profile.created',
          actorId: null, // nobody to attribute the bootstrap to (PRO-008)
          payload: { profile_id: profile.id, name: profile.name, avatar: profile.avatar, role: profile.role },
          clientTs: new Date(),
        })
        await client.query('COMMIT')
        app.bus.notify()
        return reply.status(201).send(profile)
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    }

    if (req.profile.role !== 'parent') throw parentRequired() // PRO-002/005, as before
    const body = createSchema.parse(req.body)
    const { rows } = await app.pool.query(
      'INSERT INTO profiles (name, avatar, role) VALUES ($1, $2, $3) RETURNING id, name, avatar, role',
      [body.name, body.avatar, body.role],
    )
    const profile = rows[0]
    await appendEvent(app.pool, {
      type: 'profile.created',
      actorId: req.profile.id,
      payload: { profile_id: profile.id, name: profile.name, avatar: profile.avatar, role: profile.role },
      clientTs: new Date(),
    })
    app.bus.notify()
    return reply.status(201).send(profile)
  })

  app.patch('/api/profiles/:id', { preHandler: [requireParent] }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = updateSchema.parse(req.body)
    const { rows } = await app.pool.query(
      `UPDATE profiles SET
         name = COALESCE($2, name), avatar = COALESCE($3, avatar), role = COALESCE($4, role)
       WHERE id = $1 RETURNING id, name, avatar, role`,
      [id, body.name ?? null, body.avatar ?? null, body.role ?? null],
    )
    if (rows.length === 0) throw notFound('Profile')
    const profile = rows[0]
    await appendEvent(app.pool, {
      type: 'profile.updated',
      actorId: req.profile!.id,
      payload: { profile_id: profile.id, name: profile.name, avatar: profile.avatar, role: profile.role },
      clientTs: new Date(),
    })
    app.bus.notify()
    return profile
  })
}
