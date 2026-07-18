import { createPool, migrate } from './db.js'
import { seedConfigDefaults } from './config.js'
import { buildApp } from './app.js'

const pool = createPool()
await migrate(pool)
await seedConfigDefaults(pool)

const app = await buildApp({ pool, logger: true })
const port = Number(process.env.PORT ?? 8080)
await app.listen({ port, host: '0.0.0.0' })
