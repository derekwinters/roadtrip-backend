import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { buildApp } from '../../src/app.js'
import { createPool } from '../../src/db.js'

/**
 * Contract test: the OpenAPI document and the implemented Fastify routes must agree
 * exactly. The same comparison runs in scripts/validate-specs.mjs; this test keeps the
 * guarantee inside the regular test suite as well.
 */
describe('openapi contract', () => {
  it('implemented routes and documented paths match exactly [API-003]', async () => {
    const doc = parse(await readFile(new URL('../../docs/spec/openapi.yaml', import.meta.url), 'utf8'))
    const documented = new Set<string>()
    for (const [p, methods] of Object.entries<Record<string, unknown>>(doc.paths ?? {})) {
      for (const method of Object.keys(methods)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          documented.add(`${method.toUpperCase()} ${p.replace(/\{[^}]+\}/g, ':param')}`)
        }
      }
    }

    const implemented = new Set<string>()
    const pool = createPool('postgres://unused:unused@127.0.0.1:1/unused') // never connected
    const app = await buildApp({
      pool,
      onRoute: (method, url) => implemented.add(`${method} ${url.replace(/:[^/]+/g, ':param')}`),
    })
    await app.close()

    expect([...implemented].filter((r) => !documented.has(r))).toEqual([])
    expect([...documented].filter((r) => !implemented.has(r))).toEqual([])
  })

  it('GET /api/geocode 200 body stays a bare array of GeocodeMatch, never a {results} envelope [GSR-002]', async () => {
    const doc = parse(await readFile(new URL('../../docs/spec/openapi.yaml', import.meta.url), 'utf8'))
    const schema = doc.paths?.['/api/geocode']?.get?.responses?.['200']?.content?.['application/json']?.schema
    expect(schema).toBeDefined()
    // A bare top-level array — not an object envelope. Guards against a future edit that would
    // wrap the payload (silently "fixing" a mis-parsing client while breaking the wire contract).
    expect(schema.type).toBe('array')
    expect(schema).not.toHaveProperty('properties') // i.e. not `type: object` with `results`
    expect(schema.items?.$ref).toBe('#/components/schemas/GeocodeMatch')
    expect(schema.maxItems).toBe(5)
  })
})
