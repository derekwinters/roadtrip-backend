import type { FastifyReply, FastifyRequest } from 'fastify'
import { parentRequired, unauthenticated } from './errors.js'

export interface Profile {
  id: string
  name: string
  avatar: string
  role: 'parent' | 'kid'
}

declare module 'fastify' {
  interface FastifyRequest {
    profile: Profile | null
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Identity = profile selection via X-Profile-Id (SYS-008, PRO-003/004). The role is read
 * fresh from the database on every request so role changes apply immediately.
 */
export async function loadProfile(req: FastifyRequest): Promise<void> {
  req.profile = null
  const id = req.headers['x-profile-id']
  if (typeof id !== 'string' || !UUID_RE.test(id)) return
  const { rows } = await req.server.pool.query(
    'SELECT id, name, avatar, role FROM profiles WHERE id = $1',
    [id],
  )
  if (rows.length === 1) req.profile = rows[0]
}

export async function requireProfile(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.profile) throw unauthenticated()
}

export async function requireParent(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.profile) throw unauthenticated()
  if (req.profile.role !== 'parent') throw parentRequired()
}
