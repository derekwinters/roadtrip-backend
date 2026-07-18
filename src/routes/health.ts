import type { FastifyInstance } from 'fastify'
import { readFile } from 'node:fs/promises'

let version: string | null = null

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // SYS-005 — connectivity probe used by clients to detect online state.
  app.get('/api/health', async () => {
    if (!version) {
      try {
        const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
        version = String(pkg.version)
      } catch {
        version = 'unknown'
      }
    }
    return { status: 'ok', version }
  })
}
