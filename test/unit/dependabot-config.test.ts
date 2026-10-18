import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'

/**
 * Dependabot PRs close no issue, so they must carry `no-closing-keyword` to pass the
 * closing-keyword check. Setting `labels:` replaces Dependabot's defaults, so each entry
 * must also keep `dependencies`.
 */
describe('dependabot config', () => {
  it('every updates entry labels its PRs no-closing-keyword and dependencies [REL-009]', async () => {
    const doc = parse(await readFile(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8')) as {
      updates?: Array<{ 'package-ecosystem': string; labels?: string[] }>
    }
    const updates = doc.updates ?? []
    expect(updates.length).toBeGreaterThan(0)
    for (const entry of updates) {
      expect(entry.labels, entry['package-ecosystem']).toEqual(
        expect.arrayContaining(['no-closing-keyword', 'dependencies']),
      )
    }
  })

  it('the docker entry ignores semver-major updates of node [REL-010]', async () => {
    const doc = parse(await readFile(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8')) as {
      updates?: Array<{
        'package-ecosystem': string
        ignore?: Array<{ 'dependency-name': string; 'update-types'?: string[] }>
      }>
    }
    const docker = (doc.updates ?? []).find((e) => e['package-ecosystem'] === 'docker')
    expect(docker).toBeDefined()
    const rule = docker?.ignore?.find((r) => r['dependency-name'] === 'node')
    expect(rule?.['update-types']).toEqual(expect.arrayContaining(['version-update:semver-major']))
  })
})
