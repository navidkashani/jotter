import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import { scanVault, clearVaultCache } from '../src/lib/vault.js'
import { resolveLink, resolveAsset, displayFor, splitTarget } from '../src/lib/resolve.js'

const VAULT = fileURLToPath(new URL('./fixtures/vault', import.meta.url))
const vault = () => {
  clearVaultCache()
  return scanVault({ root: VAULT })
}

describe('splitTarget', () => {
  it('separates a subpath from the path', () => {
    expect(splitTarget('folder/Note#Heading')).toEqual({ path: 'folder/Note', subpath: '#Heading' })
    expect(splitTarget('Note')).toEqual({ path: 'Note', subpath: '' })
    expect(splitTarget('#Local')).toEqual({ path: '', subpath: '#Local' })
    expect(splitTarget('Note#^block-id')).toEqual({ path: 'Note', subpath: '#^block-id' })
  })
})

describe('resolveLink — shortest (Obsidian default)', () => {
  const v = vault()

  it('matches a bare filename anywhere in the vault', () => {
    const r = resolveLink('Luhmann', 'Home.md', v)
    expect(r.status).toBe('published')
    expect(r.note?.path).toBe('notes/Luhmann.md')
  })

  it('is case-insensitive on filenames', () => {
    expect(resolveLink('luhmann', 'Home.md', v).note?.path).toBe('notes/Luhmann.md')
    expect(resolveLink('LUHMANN', 'Home.md', v).note?.path).toBe('notes/Luhmann.md')
  })

  it('matches an exact vault path, with or without the extension', () => {
    expect(resolveLink('notes/Luhmann', 'Home.md', v).note?.path).toBe('notes/Luhmann.md')
    expect(resolveLink('notes/Luhmann.md', 'Home.md', v).note?.path).toBe('notes/Luhmann.md')
  })

  it('resolves non-ASCII filenames', () => {
    expect(resolveLink('Заметка', 'Home.md', v).note?.path).toBe('notes/Заметка.md')
    expect(resolveLink('Ideas 💡', 'Home.md', v).note?.path).toBe('notes/Ideas 💡.md')
  })

  it('resolves a percent-encoded target', () => {
    expect(resolveLink('notes/Ideas%20%F0%9F%92%A1', 'Home.md', v).note?.path).toBe('notes/Ideas 💡.md')
  })

  it('reports ambiguity and picks the shallowest path', () => {
    const r = resolveLink('Note', 'Zettelkasten.md', v)
    expect(r.note?.path).toBe('notes/Note.md')
    expect(r.ambiguity?.map((c) => c.path).sort()).toEqual(['notes/Note.md', 'notes/nested/note.md'])
  })

  it('resolves an alias', () => {
    expect(resolveLink('Slipbox', 'Home.md', v).note?.path).toBe('Zettelkasten.md')
    expect(resolveLink('Zettel Method', 'Home.md', v).note?.path).toBe('Zettelkasten.md')
  })

  it('prefers a real filename over an alias that shadows it', () => {
    // `private/Secret Log.md` claims the alias `Luhmann`; the real note wins.
    expect(resolveLink('Luhmann', 'Home.md', v).note?.path).toBe('notes/Luhmann.md')
  })

  it('marks an unpublished target unpublished rather than resolved', () => {
    const r = resolveLink('Secret Log', 'Home.md', v)
    expect(r.status).toBe('unpublished')
    expect(r.note?.path).toBe('private/Secret Log.md')
  })

  it('returns unresolved for a target that matches nothing', () => {
    expect(resolveLink('Nothing At All', 'Home.md', v).status).toBe('unresolved')
  })

  it('carries the anchor through', () => {
    expect(resolveLink('Luhmann#Some Heading', 'Home.md', v).anchor).toBe('#Some Heading')
  })

  it('resolves a bare anchor to the current note', () => {
    const r = resolveLink('#Heading', 'notes/Luhmann.md', v)
    expect(r.note?.path).toBe('notes/Luhmann.md')
    expect(r.anchor).toBe('#Heading')
  })
})

describe('resolveLink — absolute and relative', () => {
  const v = vault()

  it('absolute reads a path from the vault root', () => {
    expect(resolveLink('notes/Luhmann', 'cycles/A.md', v, 'absolute').note?.path).toBe('notes/Luhmann.md')
  })

  it('relative reads a path from the linking note', () => {
    // From notes/nested/note.md, `../Luhmann` is notes/Luhmann.md
    expect(resolveLink('../Luhmann', 'notes/nested/note.md', v, 'relative').note?.path).toBe(
      'notes/Luhmann.md',
    )
  })

  it('shortest also accepts a relative path, absolute does not', () => {
    expect(resolveLink('nested/note', 'notes/Note.md', v, 'shortest').note?.path).toBe(
      'notes/nested/note.md',
    )
    // `absolute` skips the relative lookup, so this falls through to the
    // filename match on `note` and lands on the shallower file.
    expect(resolveLink('nested/note', 'notes/Note.md', v, 'absolute').note?.path).toBe('notes/Note.md')
  })
})

describe('resolveAsset', () => {
  const v = vault()

  it('finds an attachment by bare filename', () => {
    expect(resolveAsset('diagram.png', 'Zettelkasten.md', v)).toBe('attachments/diagram.png')
  })

  it('finds an attachment by full path', () => {
    expect(resolveAsset('attachments/diagram.png', 'Home.md', v)).toBe('attachments/diagram.png')
  })

  it('returns undefined for a missing attachment', () => {
    expect(resolveAsset('nope.png', 'Home.md', v)).toBeUndefined()
  })
})

describe('displayFor', () => {
  it('prefers an explicit alias', () => {
    expect(displayFor('private/Secret Log', 'the private one')).toBe('the private one')
  })

  it('falls back to the basename, never a note title', () => {
    // This is the privacy guarantee: an unpublished note's *title* must never
    // reach the page through a link somebody else wrote to it.
    expect(displayFor('private/Secret Log')).toBe('Secret Log')
    expect(displayFor('private/Secret Log')).not.toContain('Very Private')
  })

  it('renders a heading link the way Obsidian does', () => {
    expect(displayFor('Note#Section')).toBe('Note > Section')
  })

  it('drops a block reference from the label', () => {
    expect(displayFor('Note#^abc123')).toBe('Note')
  })
})
