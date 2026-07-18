import Fastify, { type FastifyInstance } from 'fastify'
import type pg from 'pg'
import { ZodError } from 'zod'
import { EventBus } from './bus.js'
import { AppError } from './errors.js'
import { loadProfile } from './auth.js'
import { healthRoutes } from './routes/health.js'
import { profileRoutes } from './routes/profiles.js'
import { configRoutes } from './routes/config.js'
import { destinationRoutes } from './routes/destinations.js'
import { syncRoutes } from './routes/sync.js'
import { eventRoutes } from './routes/events.js'
import { journalRoutes } from './routes/journal.js'
import { mapRoutes } from './routes/map.js'
import { checklistRoutes } from './routes/checklist.js'
import { legRoutes } from './routes/legs.js'
import { tripRoutes } from './routes/trip.js'
import { tripsRoutes } from './routes/trips.js'
import { gameRoutes } from './routes/games.js'
import { bingoRoutes } from './routes/bingo.js'
import { notificationRoutes } from './routes/notifications.js'
import { geocodeRoutes } from './routes/geocode.js'
import { GeocodeSearch, type GeocodeSearchOptions } from './geocode/search.js'

declare module 'fastify' {
  interface FastifyInstance {
    pool: pg.Pool
    bus: EventBus
  }
}

export interface BuildOptions {
  pool: pg.Pool
  logger?: boolean
  /** Invoked for every registered route; used by the spec validator (API-003). */
  onRoute?: (method: string, url: string) => void
  /** Geocode proxy injection — tests stub the upstream fetcher/spacing (GSR-002/005). */
  geocode?: GeocodeSearchOptions
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false })

  if (opts.onRoute) {
    const cb = opts.onRoute
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const m of methods) if (m !== 'HEAD' && m !== 'OPTIONS') cb(m, route.url)
    })
  }

  app.decorate('pool', opts.pool)
  app.decorate('bus', new EventBus())
  app.decorateRequest('profile', null)
  app.addHook('preHandler', loadProfile)

  // Error envelope with stable machine codes (API-001/002).
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } })
    }
    if (err instanceof ZodError) {
      const msg = err.issues[0] ? `${err.issues[0].path.join('.')}: ${err.issues[0].message}` : 'Invalid input'
      return reply.status(400).send({ error: { code: 'validation', message: msg } })
    }
    const anyErr = err as { statusCode?: unknown; message?: unknown }
    if (typeof anyErr.statusCode === 'number' && anyErr.statusCode < 500) {
      return reply
        .status(anyErr.statusCode)
        .send({ error: { code: 'validation', message: String(anyErr.message ?? 'Bad request') } })
    }
    app.log.error(err)
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error' } })
  })

  // Unknown /api routes get the envelope too (API-004).
  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } }),
  )

  await app.register(healthRoutes)
  await app.register(profileRoutes)
  await app.register(configRoutes)
  await app.register(destinationRoutes)
  await app.register(syncRoutes)
  await app.register(eventRoutes)
  await app.register(journalRoutes)
  await app.register(mapRoutes)
  await app.register(checklistRoutes)
  await app.register(legRoutes)
  await app.register(tripRoutes)
  await app.register(tripsRoutes)
  await app.register(gameRoutes)
  await app.register(bingoRoutes)
  await app.register(notificationRoutes)
  await app.register(geocodeRoutes(new GeocodeSearch(opts.pool, opts.geocode)))

  return app
}
