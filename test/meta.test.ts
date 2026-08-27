/**
 * Assertions about the shape of the source, not about what it does.
 *
 * Six bugs of one shape have now been found by hand: `analytics`,
 * `features.rss`, frontmatter `homepage: true` and `image:` were each declared
 * and read by nothing, and `calloutIcon`, `enabledFeatures` and `aliasRedirects`
 * were each written and called by nobody. Every one was invisible for the same
 * reason — nothing compared the list of things jotter *offers* against the list
 * of things jotter *uses*, so a promise with no reader looked exactly like a
 * promise being kept.
 *
 * These two tests are that comparison, and they are the reason the seventh does
 * not need to be found by reading the repository.
 *
 * Its own file, and the corpus below excludes it, deliberately: the exemption
 * lists name the very symbols they exempt, so a scan that read this file would
 * count each mention as a reader and pass for exactly the wrong reason.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DISPLAYED_FIELDS } from '../src/lib/frontmatter.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SELF = join('test', 'meta.test.ts')

/** Everything that could plausibly reference a symbol or an i18n key. */
const READABLE = new Set(['.ts', '.astro', '.mjs', '.js'])

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const rel = join(dir, entry.name)
    if (entry.isDirectory()) sources(rel, out)
    else if (READABLE.has(rel.slice(rel.lastIndexOf('.')))) out.push(rel)
  }
  return out
}

const files = [
  ...sources('src'),
  ...sources('test'),
  ...sources('scripts'),
  'astro.config.ts',
  'jotter.config.ts',
].filter((f) => f !== SELF)

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')
const corpus = files.map((file) => ({ file, text: read(file) }))

describe('nothing in src/lib is written for nobody', () => {
  /**
   * Value exports only. A type is erased before anything runs, and an unused
   * one costs a reader nothing and `astro check` already notices it in-file.
   * What this is looking for is *behaviour* that ships and is never invoked.
   */
  const EXPORTED = /^export (?:async )?(?:function|const|class) (\w+)/gm

  /**
   * Kept deliberately, and each one has to say why. An exemption with no
   * reason attached is how the next `calloutIcon` survives a decade.
   *
   * `outgoingFor` is one half of an outgoing-links section — the other half is
   * the `note.links` string below — that is a design decision still open:
   * whether a note should list what it links *to* beside what links to it.
   * Delete both, or build it; do not leave this entry here indefinitely.
   */
  const PENDING = new Map([['outgoingFor', 'half of the undecided outgoing-links section']])

  const libs = sources(join('src', 'lib'))

  it('exports something from every module it has', () => {
    // Guards the walk itself: a broken path would make every check below pass.
    expect(libs.length).toBeGreaterThan(10)
  })

  it('has a reader for every value it exports', () => {
    const orphans: string[] = []

    for (const lib of libs) {
      const text = read(lib)
      for (const [, name] of text.matchAll(EXPORTED)) {
        if (PENDING.has(name)) continue
        const used = corpus.some(
          ({ file, text: other }) =>
            file !== lib && new RegExp(`\\b${name}\\b`).test(other),
        )
        if (!used) orphans.push(`${relative('src/lib', lib)}: ${name}`)
      }
    }

    expect(orphans, 'exported and never used — delete it, or wire it up').toEqual([])
  })

  /** An exemption that has quietly become true again is dead weight of its own. */
  it('keeps no exemption that is no longer needed', () => {
    for (const [name] of PENDING) {
      const used = corpus.some(({ file, text }) =>
        !file.startsWith(join('src', 'lib')) && new RegExp(`\\b${name}\\b`).test(text),
      )
      expect(used, `${name} has a reader now; drop it from PENDING`).toBe(false)
    }
  })
})

describe('nothing in en.json is translated for nobody', () => {
  const strings = Object.keys(JSON.parse(read(join('src', 'i18n', 'en.json'))))

  /**
   * The one place a key is *built* rather than written out, so its five keys
   * appear in no file as literals. Derived from `DISPLAYED_FIELDS` rather than
   * listed, so adding a header field cannot silently need an entry here too.
   *
   * A second dynamic `t()` anywhere will fail this test rather than slip past
   * it, which is the right way round: a key nothing can be shown to ask for is
   * a key nobody can be shown to have translated correctly.
   */
  const BUILT = DISPLAYED_FIELDS.map((field) => `note.field.${field}`)

  /** Kept for the reason `outgoingFor` is. Both go, or both get built. */
  const PENDING = new Set(['note.links'])

  it('has more than a handful of strings to check', () => {
    expect(strings.length).toBeGreaterThan(20)
  })

  it('has an asker for every string it defines', () => {
    const unasked = strings.filter(
      (key) =>
        !PENDING.has(key) &&
        !BUILT.includes(key) &&
        !corpus.some(({ text }) => text.includes(key)),
    )
    expect(unasked, 'defined and never asked for — a translator would translate it for nothing').toEqual([])
  })

  /** The other direction: a key that is asked for and does not exist renders as itself. */
  it('defines every key a component builds', () => {
    for (const key of BUILT) expect(strings).toContain(key)
  })
})
