#!/usr/bin/env node
/**
 * Documentation validator (docs/spec/10-testing.md).
 *
 * Fails the build when:
 *  1. a requirement ID is defined twice,
 *  2. an `auto` requirement has no referencing test,
 *  3. a relative markdown link in docs/ or README/CLAUDE files is broken,
 *  4. openapi.yaml doesn't parse, or implemented Fastify routes and documented
 *     paths disagree (API-003).
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const errors = []

async function walk(dir, filter) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full, filter)))
    else if (filter(full)) out.push(full)
  }
  return out
}

// ---- 1 & 2: requirement tables vs test references ----------------------------------
const REQ_ROW = /^\|\s*([A-Z]+-\d{3})\s*\|(.+)\|\s*(auto|manual)\s*\|\s*$/
const specFiles = await walk(path.join(root, 'docs'), (f) => f.endsWith('.md'))
const requirements = new Map() // id -> {file, verify}
for (const file of specFiles) {
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    const m = line.match(REQ_ROW)
    if (!m) continue
    const [, id, , verify] = m
    if (requirements.has(id)) {
      errors.push(`Duplicate requirement ID ${id} (${path.relative(root, file)} and ${requirements.get(id).file})`)
    } else {
      requirements.set(id, { file: path.relative(root, file), verify })
    }
  }
}
if (requirements.size === 0) errors.push('No requirement tables found under docs/ — spec drift?')

const testFiles = [
  ...(await walk(path.join(root, 'test'), (f) => f.endsWith('.ts'))),
  ...(await walk(path.join(root, 'scripts'), (f) => f.endsWith('.ts') || f.endsWith('.mjs'))),
]
const testCorpus = (await Promise.all(testFiles.map((f) => readFile(f, 'utf8')))).join('\n')

for (const [id, meta] of requirements) {
  if (meta.verify !== 'auto') continue
  if (!testCorpus.includes(id)) {
    errors.push(`Requirement ${id} (${meta.file}) is marked auto but no test references it`)
  }
}

// ---- 3: relative markdown links -----------------------------------------------------
const mdFiles = [
  ...specFiles,
  ...['README.md', 'CLAUDE.md'].map((f) => path.join(root, f)).filter((f) => existsSync(f)),
]
const LINK = /\[[^\]]*\]\(([^)]+)\)/g
for (const file of mdFiles) {
  const text = await readFile(file, 'utf8')
  for (const m of text.matchAll(LINK)) {
    const target = m[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const resolved = path.resolve(path.dirname(file), target.split('#')[0])
    if (!existsSync(resolved)) errors.push(`Broken link in ${path.relative(root, file)}: ${target}`)
  }
}

// ---- 4: OpenAPI ↔ implemented routes ------------------------------------------------
try {
  const { parse } = await import('yaml')
  const doc = parse(await readFile(path.join(root, 'docs/spec/openapi.yaml'), 'utf8'))
  const documented = new Set()
  for (const [p, methods] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        documented.add(`${method.toUpperCase()} ${p.replace(/\{[^}]+\}/g, ':param')}`)
      }
    }
  }

  // Build the app with a route-collection hook; the pool is never connected.
  const { createPool } = await import('../src/db.js')
  const { buildApp } = await import('../src/app.js')
  const implemented = new Set()
  const pool = createPool('postgres://unused:unused@127.0.0.1:1/unused')
  const app = await buildApp({
    pool,
    onRoute: (method, url) => implemented.add(`${method} ${url.replace(/:[^/]+/g, ':param')}`),
  })
  await app.close()

  for (const r of implemented) {
    if (!documented.has(r)) errors.push(`Route implemented but not in openapi.yaml: ${r}`)
  }
  for (const r of documented) {
    if (!implemented.has(r)) errors.push(`Route documented in openapi.yaml but not implemented: ${r}`)
  }
} catch (err) {
  errors.push(`OpenAPI validation failed to run: ${err.message}`)
}

// ---- report -------------------------------------------------------------------------
const autoCount = [...requirements.values()].filter((r) => r.verify === 'auto').length
if (errors.length > 0) {
  console.error(`Spec validation FAILED with ${errors.length} problem(s):\n`)
  for (const e of errors) console.error(`  ✗ ${e}`)
  process.exit(1)
}
console.log(
  `Spec validation OK: ${requirements.size} requirements (${autoCount} auto, all test-covered), ` +
    `${mdFiles.length} docs checked, OpenAPI and routes in sync.`,
)
