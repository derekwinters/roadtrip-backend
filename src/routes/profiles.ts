import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireParent } from '../auth.js'
import { appendEvent } from '../events/store.js'
import { notFound } from '../errors.js'

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    avatar: z.string().min(1).max(16).default('🙂'),
    role: z.enum(['parent', 'kid']),
  })
  .strict()

const updateSchema = createSchema.partial()

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  // PRO-001 — unauthenticated: this is the login screen datasource.
  app.get('/api/profiles', async () => {
    const { rows } = await app.pool.query(
      'SELECT id, name, avatar, role FROM profiles ORDER BY created_at',
    )
    return rows
  })

  // PRO-002 / PRO-007
  app.post('/api/profiles', { preHandler: [requireParent] }, async (req, reply) => {
    const body = createSchema.parse(req.body)
    const { rows } = await app.pool.query(
      'INSERT INTO profiles (name, avatar, role) VALUES ($1, $2, $3) RETURNING id, name, avatar, role',
      [body.name, body.avatar, body.role],
    )
    const profile = rows[0]
    await appendEvent(app.pool, {
      type: 'profile.created',
      actorId: req.profile!.id,
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
