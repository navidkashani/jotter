import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseLinksIndex } from '../src/lib/links-index.js'
import { scanVault, clearVaultCache } from '../src/lib/vault.js'
import { resolveLink } from '../src/lib/resolve.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/vault', import.meta.url))

/** A throwaway copy of the fixture vault, plus a `.jotter/links.json`. */
function vaultWithIndex(index: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'jotter-links-'))
  cpSync(FIXTURE, root, { recursive: true })
  mkdirSync(join(root, '.jotter'), { recursive: true })
  writeFileSync(join(root, '.jotter', 'links.json'), JSON.stringify(index))
  clearVaultCache()
  return scanVault({ root })
}

describe('parseLinksIndex', () => {
  it('reads a bare map of note paths', () => {
    const index = parseLinksIndex(
      JSON.stringify({ 'Home.md': [{ raw: 'Zettelkasten', status: 'published', slug: 'zettelkasten' }] }),
    )!
    expect(index.size).toBe(1)
    expect(index.lookup('Home.md', 'Zettelkasten')?.slug).toBe('zettelkasten')
  })

  it('also reads a snapshot-shaped file', () => {
    const index = parseLinksIndex(
      JSON.stringify({ version: 1, links: { 'a.md': [{ raw: 'B', status: 'unresolved' }] } }),
    )!
    expect(index.lookup('a.md', 'B')?.status).toBe('unresolved')
  })

  it('matches the note path case-insensitively', () => {
    const index = parseLinksIndex(JSON.stringify({ 'Home.md': [{ raw: 'X', status: 'unresolved' }] }))!
    expect(index.lookup('home.md', 'X')).toBeDefined()
  })

  it('degrades to undefined, with a warning, on malformed input', () => {
    for (const source of ['not json', '[]', '{}', 'null', '{"links": 4}']) {
      const warnings: string[] = []
      expect(parseLinksIndex(source, warnings)).toBeUndefined()
      expect(warnings.length).toBeGreaterThan(0)
    }
  })

  it('skips entries missing the fields it needs', () => {
    const warnings: string[] = []
    expect(parseLinksIndex(JSON.stringify({ 'a.md': [{ nope: 1 }] }), warnings)).toBeUndefined()
  })
})

describe('.jotter/links.json overrides resolution', () => {
  it('wins over jotter’s own answer', () => {
    // Left to itself, `Note` is ambiguous and resolves to the shallower file.
    // The index says otherwise, and the index is authoritative.
    const vault = vaultWithIndex({
      'Zettelkasten.md': [{ raw: 'Note', status: 'published', slug: 'notes/nested/note' }],
    })
    const resolved = resolveLink('Note', 'Zettelkasten.md', vault)
    expect(resolved.note?.path).toBe('notes/nested/note.md')
    expect(resolved.ambiguity).toBeUndefined()
  })

  it('makes a link dead when the index says it is not published', () => {
    const vault = vaultWithIndex({
      'Zettelkasten.md': [{ raw: 'Luhmann', status: 'unpublished' }],
    })
    expect(resolveLink('Luhmann', 'Zettelkasten.md', vault).status).toBe('unresolved')
  })

  it('falls back when the index names a slug this build does not have', () => {
    const vault = vaultWithIndex({
      'Zettelkasten.md': [{ raw: 'Luhmann', status: 'published', slug: 'gone/missing' }],
    })
    // Rather than link to a page that will not exist, jotter resolves it itself.
    expect(resolveLink('Luhmann', 'Zettelkasten.md', vault).note?.path).toBe('notes/Luhmann.md')
  })

  it('leaves links the index does not name to the normal resolver', () => {
    const vault = vaultWithIndex({ 'Home.md': [{ raw: 'Zettelkasten', status: 'published', slug: 'zettelkasten' }] })
    expect(resolveLink('Luhmann', 'Zettelkasten.md', vault).note?.path).toBe('notes/Luhmann.md')
  })

  it('says in the build log that it is being used', () => {
    const vault = vaultWithIndex({ 'Home.md': [{ raw: 'X', status: 'unresolved' }] })
    expect(vault.warnings.some((w) => w.includes('.jotter/links.json'))).toBe(true)
  })

  it('is absent for a vault without one', () => {
    clearVaultCache()
    expect(scanVault({ root: FIXTURE }).linkOverrides).toBeUndefined()
  })
})
