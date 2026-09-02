import { describe, expect, it } from 'vitest'

import { protectedRanges, isProtected, anchorFor } from '../src/lib/protected.js'
import {
  assignSlugs,
  normalizePermalinks,
  obsidianPath,
  preservePath,
  slugFor,
  slugHazards,
  slugifyHeading,
  slugifyPath,
  slugifySegment,
} from '../src/lib/slug.js'
import { decodeSlug, encodeSlug } from '../src/lib/url.js'
import { mergeTags, inlineTags, frontmatterTags, expandTag, tagTree, normalizeTag } from '../src/lib/tags.js'
import { resolveDates, frontmatterDate } from '../src/lib/dates.js'
import { excerpt } from '../src/lib/excerpt.js'
import { sectionOf, sectionById } from '../src/lib/transclude.js'
import { previewFor } from '../src/lib/preview.js'
import type { VaultNote } from '../src/lib/vault.js'
import { parseCallout } from '../src/lib/callout.js'
import { analyticsTag } from '../src/lib/analytics.js'
import { analyticsProviders } from '../src/lib/config.js'
import { parseEmbedPipe, isMediaTarget } from '../src/lib/embed.js'
import {
  excerptParts,
  headingJumps,
  isTypingTarget,
  nextStop,
  normalizeResultUrl,
} from '../src/lib/search.js'

describe('protectedRanges: parity with open-publish rewrite.mjs', () => {
  it('protects frontmatter', () => {
    const text = '---\ntitle: A [[Link]]\n---\n\nBody [[Real]].'
    const ranges = protectedRanges(text)
    expect(isProtected(ranges, text.indexOf('[[Link]]'))).toBe(true)
    expect(isProtected(ranges, text.indexOf('[[Real]]'))).toBe(false)
  })

  it('protects fenced code blocks including the fence lines', () => {
    const text = 'Before [[A]]\n```\n[[B]]\n```\nAfter [[C]]'
    const ranges = protectedRanges(text)
    expect(isProtected(ranges, text.indexOf('[[A]]'))).toBe(false)
    expect(isProtected(ranges, text.indexOf('[[B]]'))).toBe(true)
    expect(isProtected(ranges, text.indexOf('[[C]]'))).toBe(false)
  })

  it('handles tilde fences and longer backtick runs', () => {
    const text = '~~~\n[[A]]\n~~~\n\n````\n```\n[[B]]\n````\n\n[[C]]'
    const ranges = protectedRanges(text)
    expect(isProtected(ranges, text.indexOf('[[A]]'))).toBe(true)
    expect(isProtected(ranges, text.indexOf('[[B]]'))).toBe(true)
    expect(isProtected(ranges, text.indexOf('[[C]]'))).toBe(false)
  })

  it('protects inline code spans', () => {
    const text = 'Use `[[A]]` but link [[B]].'
    const ranges = protectedRanges(text)
    expect(isProtected(ranges, text.indexOf('[[A]]'))).toBe(true)
    expect(isProtected(ranges, text.indexOf('[[B]]'))).toBe(false)
  })

  it('leaves an unterminated fence protecting the rest of the file', () => {
    const text = 'Start [[A]]\n```\n[[B]]\n[[C]]'
    const ranges = protectedRanges(text)
    expect(isProtected(ranges, text.indexOf('[[B]]'))).toBe(true)
    expect(isProtected(ranges, text.indexOf('[[C]]'))).toBe(true)
  })
})

describe('anchorFor', () => {
  it('slugifies a heading subpath', () => {
    expect(anchorFor('#Some Heading')).toBe('#some-heading')
    expect(anchorFor('#With, Punctuation!')).toBe('#with-punctuation')
  })

  it('returns nothing for block refs and empty subpaths', () => {
    expect(anchorFor('#^abc123')).toBe('')
    expect(anchorFor('')).toBe('')
    expect(anchorFor(undefined)).toBe('')
  })
})

describe('slugify', () => {
  it('lowercases and dashes a path', () => {
    expect(slugifyPath('Notes/My Note.md')).toBe('notes/my-note')
  })

  it('keeps non-ASCII letters rather than dropping the whole name', () => {
    expect(slugifyPath('notes/Заметка.md')).toBe('notes/заметка')
    expect(slugifySegment('Ideas 💡')).toBe('ideas')
  })

  it('lets index.md claim its folder', () => {
    expect(slugifyPath('Notes/index.md')).toBe('notes')
    expect(slugifyPath('index.md')).toBe('index')
  })

  it('collapses separators and trims stray dashes', () => {
    expect(slugifySegment('A & B __ C')).toBe('a-b-c')
    expect(slugifySegment('--edge--')).toBe('edge')
  })

  it('never returns an empty slug', () => {
    expect(slugifyPath('💡/🎉.md')).toBe('untitled')
  })

  it('breaks collisions deterministically, independent of input order', () => {
    const a = assignSlugs(['b/Note.md', 'a/Note.md'])
    const b = assignSlugs(['a/Note.md', 'b/Note.md'])
    expect([...a.slugs]).toEqual([...b.slugs])
  })

  it('reports which paths collided', () => {
    const { slugs, collisions } = assignSlugs(['A B.md', 'a-b.md'])
    expect(new Set(slugs.values()).size).toBe(2)
    expect(collisions[0].paths.length).toBe(2)
  })

  it('slugifies headings the way github-slugger does', () => {
    expect(slugifyHeading('Hello, World!')).toBe('hello-world')
  })
})

/**
 * The five acceptance rows, in all three styles, from one table, so a mode
 * that quietly starts lowercasing, or a rule that only survives in `derive`,
 * fails here rather than on somebody's live site.
 */
describe('slugFor: the three site-wide styles', () => {
  const ROWS: [path: string, derive: string, preserve: string, obsidian: string][] = [
    ['notes/plain.md', 'notes/plain', 'notes/plain', 'notes/plain'],
    ['Projects/Q3 Plan.md', 'projects/q3-plan', 'Projects/Q3 Plan', 'Projects/Q3+Plan'],
    [
      'Wisdom & Approaches/Critical Thinking.md',
      'wisdom-approaches/critical-thinking',
      'Wisdom & Approaches/Critical Thinking',
      'Wisdom+&+Approaches/Critical+Thinking',
    ],
    [
      // The zero-width non-joiner survives `preserve` and `obsidian` and is
      // dropped by `derive`, which keeps letters and numbers and nothing else.
      'یادداشت‌ها/تفکر نقاد.md',
      'یادداشتها/تفکر-نقاد',
      'یادداشت‌ها/تفکر نقاد',
      'یادداشت‌ها/تفکر+نقاد',
    ],
    ['index.md', 'index', 'index', 'index'],
  ]

  it.each(ROWS)('slugs %s under every style', (path, derive, preserve, obsidian) => {
    expect(slugFor(path, 'derive')).toBe(derive)
    expect(slugFor(path, 'preserve')).toBe(preserve)
    expect(slugFor(path, 'obsidian')).toBe(obsidian)
  })

  it('defaults to derive, so an unthreaded call site cannot change a site’s URLs', () => {
    expect(slugFor('Notes/My Note.md')).toBe(slugifyPath('Notes/My Note.md'))
  })

  /** The two rules that are about routing rather than naming, in every style. */
  it('drops .md and lets an index.md claim its folder in every style', () => {
    for (const style of ['derive', 'preserve', 'obsidian'] as const) {
      expect(slugFor('Notes/index.md', style)).not.toMatch(/index$/)
      expect(slugFor('Notes/index.md', style)).not.toMatch(/\.md$/)
    }
    expect(slugFor('Notes/index.md', 'preserve')).toBe('Notes')
    // The root one is the exception: `index` is how jotter spells `/`.
    expect(slugFor('index.md', 'preserve')).toBe('index')
  })

  it('normalises the slug to NFC while never touching the path', () => {
    const nfd = 'Café.md' // as macOS Finder writes it
    expect(slugFor(nfd, 'preserve')).toBe('Café'.normalize('NFC'))
    expect(slugFor(nfd, 'preserve').normalize('NFD')).not.toBe(slugFor(nfd, 'preserve'))
    expect(preservePath(nfd)).toBe('Café'.normalize('NFC'))
  })

  it('keeps assignSlugs deterministic under a non-derive style', () => {
    const paths = ['B/Note.md', 'A/Note.md']
    const a = assignSlugs(paths, 'obsidian')
    const b = assignSlugs([...paths].reverse(), 'obsidian')
    expect([...a.slugs]).toEqual([...b.slugs])
    expect(a.slugs.get('A/Note.md')).toBe('A/Note')
  })
})

/**
 * The parity claim, asserted rather than described. `obsidianPublishUrl` is
 * copied verbatim from open-publish's `plugin/src/core/slug.ts`; the two
 * projects have to agree character for character or a vault published by the
 * plugin and rebuilt by jotter answers at two different sets of addresses.
 */
describe('obsidianPath: parity with open-publish slug.ts', () => {
  const obsidianPublishUrl = (path: string): string =>
    path
      .replace(/\.md$/i, '')
      .split('/')
      .map((segment) => segment.replace(/ /g, '+'))
      .join('/')

  const FIXTURES = [
    'Company/About us.md',
    'Wisdom & Approaches/Critical Thinking.md',
    'notes/plain.md',
    'Projects/Q3 Plan.md',
    'یادداشت‌ها/تفکر نقاد.md',
    'C++ Notes.md',
    'A  double  space.md',
    'attachments/diagram.png',
  ]

  it.each(FIXTURES)('agrees on %s', (path) => {
    expect(obsidianPath(path)).toBe(obsidianPublishUrl(path))
  })

  /** What the plugin's own docstring says the answer is, spelled out once. */
  it('reproduces the address Obsidian Publish served', () => {
    expect(obsidianPath('Wisdom & Approaches/Critical Thinking.md')).toBe(
      'Wisdom+&+Approaches/Critical+Thinking',
    )
    expect(encodeSlug(obsidianPath('Wisdom & Approaches/Critical Thinking.md'))).toBe(
      'Wisdom+%26+Approaches/Critical+Thinking',
    )
  })
})

describe('encodeSlug / decodeSlug: a slug is not a URL', () => {
  const SLUGS = [
    'notes/plain',
    'Wisdom+&+Approaches/Critical+Thinking',
    'یادداشت‌ها/تفکر+نقاد',
    'Company/About+us',
    '100% done',
    'a?b#c',
    'index',
  ]

  it.each(SLUGS)('round-trips %s', (slug) => {
    expect(decodeSlug(encodeSlug(slug))).toBe(slug)
  })

  it('encodes the reserved characters and leaves a literal + alone', () => {
    // `+` is a space only in a query string. In a path it is a plus, which is
    // the whole reason the stored form can carry one.
    expect(encodeSlug('Wisdom+&+Approaches')).toBe('Wisdom+%26+Approaches')
    expect(encodeSlug('a b')).toBe('a%20b')
    expect(encodeSlug('100% done')).toBe('100%25%20done')
  })

  it('keeps / a separator rather than encoding it', () => {
    expect(encodeSlug('a/b/c')).toBe('a/b/c')
  })

  it('never lowercases and never substitutes: that is slugifySegment’s job', () => {
    expect(encodeSlug('Q3 Plan')).toBe('Q3%20Plan')
    expect(encodeSlug('A & B')).not.toContain('-and-')
    expect(encodeSlug('50%')).not.toContain('-percent')
  })

  it('returns a segment it cannot decode rather than throwing', () => {
    // Pagefind reads file paths off disk, so this is what a page in
    // `dist/100% done/` arrives as.
    expect(decodeSlug('/100% done')).toBe('/100% done')
    expect(() => decodeSlug('%')).not.toThrow()
  })

  /**
   * The one place jotter cannot *spell* a URL the way Obsidian did, written
   * down so it is a known difference rather than a bug report.
   *
   * Obsidian form-urlencoded `C++ Notes.md` to `C%2B%2B+Notes`. That
   * percent-decodes to `C+++Notes`, which is the slug, so the old address
   * still resolves, because a host decodes the request path before looking for
   * the file. What is lost is only the spelling: jotter emits `C+++Notes` where
   * Obsidian emitted `C%2B%2B+Notes`, because form-urlencoding cannot be
   * recovered from a percent-decoded string. `+` there is ambiguous between a
   * space and a plus, and the slug is on the far side of that ambiguity.
   */
  it('resolves Obsidian’s form-urlencoding without reproducing its spelling', () => {
    const slug = obsidianPath('C++ Notes.md')
    expect(slug).toBe('C+++Notes')
    // The old URL and the one jotter emits are the same URL to a static host.
    expect(decodeSlug('C%2B%2B+Notes')).toBe(slug)
    expect(decodeSlug(encodeSlug(slug))).toBe(slug)
    // …and different bytes on the wire, which is the part that cannot be fixed.
    expect(encodeSlug(slug)).not.toBe('C%2B%2B+Notes')
  })
})

describe('normalizePermalinks', () => {
  it('takes the value verbatim, minus the slashes Hugo also accepts', () => {
    expect(normalizePermalinks('Company/About+us')).toEqual(['Company/About+us'])
    expect(normalizePermalinks('/Company/About+us/')).toEqual(['Company/About+us'])
  })

  it('accepts a list, in order, deduped', () => {
    expect(normalizePermalinks(['a', 'b', 'a'])).toEqual(['a', 'b'])
  })

  it('coerces the way every other frontmatter list does, and drops the empties', () => {
    expect(normalizePermalinks(2026)).toEqual(['2026'])
    expect(normalizePermalinks(['', '  ', 'x'])).toEqual(['x'])
    expect(normalizePermalinks(null)).toEqual([])
    expect(normalizePermalinks(undefined)).toEqual([])
  })

  it('never slugifies: that is the entire point of the key', () => {
    expect(normalizePermalinks('Wisdom+&+Approaches/Critical+Thinking')).toEqual([
      'Wisdom+&+Approaches/Critical+Thinking',
    ])
  })
})

describe('slugHazards: reported, never renamed', () => {
  it('names a case-only collision, which is a silent overwrite on macOS', () => {
    const [warning, ...rest] = slugHazards([
      { path: 'Note.md', slug: 'Note' },
      { path: 'note.md', slug: 'note' },
    ])
    expect(rest).toEqual([])
    expect(warning).toContain('Note.md')
    expect(warning).toContain('note.md')
    expect(warning).toMatch(/case/i)
  })

  it('names a character Windows refuses in a filename', () => {
    const [warning] = slugHazards([{ path: 'Q: A.md', slug: 'Q: A' }])
    expect(warning).toContain('Q: A.md')
    expect(warning).toMatch(/Windows/)
  })

  it('says nothing about an ordinary set of slugs', () => {
    expect(slugHazards([{ path: 'a.md', slug: 'a' }, { path: 'b.md', slug: 'b' }])).toEqual([])
  })

  it('throws on a slug that would escape dist/, naming the note', () => {
    expect(() => slugHazards([{ path: 'Note.md', slug: '../etc/passwd' }])).toThrow(/Note\.md/)
    expect(() => slugHazards([{ path: 'Note.md', slug: '/rooted' }])).toThrow(/outside dist/)
  })
})

describe('tags', () => {
  it('reads frontmatter lists, strings and comma strings', () => {
    expect(frontmatterTags(['a', 'b'])).toEqual(['a', 'b'])
    expect(frontmatterTags('a, b')).toEqual(['a', 'b'])
    expect(frontmatterTags('#a')).toEqual(['a'])
    expect(frontmatterTags(null)).toEqual([])
  })

  it('finds inline tags in prose', () => {
    expect(inlineTags('A #plain and #method/zettelkasten here.')).toEqual([
      'plain',
      'method/zettelkasten',
    ])
  })

  it('ignores tags inside code', () => {
    expect(inlineTags('Text #real\n\n```\n#fake\n```\n\n`#alsofake`')).toEqual(['real'])
  })

  it('ignores headings and all-numeric fragments', () => {
    expect(inlineTags('# Heading\n\nIssue #123 and #v2rocks')).toEqual(['v2rocks'])
  })

  it('merges both sources without duplicates', () => {
    expect(mergeTags(['a'], 'body #a #b')).toEqual(['a', 'b'])
  })

  it('normalizes stray slashes and hashes', () => {
    expect(normalizeTag('#/a//b/')).toBe('a/b')
  })

  it('expands a nested tag to its ancestors', () => {
    expect(expandTag('a/b/c')).toEqual(['a', 'a/b', 'a/b/c'])
  })

  it('rolls child counts up into parents', () => {
    const tree = tagTree([{ tags: ['method/zettelkasten'] }, { tags: ['method/other'] }, { tags: ['solo'] }])
    const method = tree.find((t) => t.tag === 'method')!
    expect(method.count).toBe(2)
    expect(method.children.map((c) => c.tag).sort()).toEqual(['method/other', 'method/zettelkasten'])
    expect(tree.find((t) => t.tag === 'solo')!.count).toBe(1)
  })
})

describe('dates', () => {
  const mtime = new Date('2020-01-01')
  const git = { created: new Date('2021-01-01'), updated: new Date('2021-06-01') }

  it('prefers frontmatter over git over mtime', () => {
    const fm = resolveDates({ created: '2022-01-01', updated: '2022-06-01' }, git, mtime)
    expect(fm.created.getUTCFullYear()).toBe(2022)
    expect(resolveDates({}, git, mtime).created.getUTCFullYear()).toBe(2021)
    expect(resolveDates({}, undefined, mtime).created.getUTCFullYear()).toBe(2020)
  })

  it('accepts the common frontmatter aliases', () => {
    expect(frontmatterDate({ date: '2023-05-05' }, ['created', 'date'])?.getUTCFullYear()).toBe(2023)
    expect(frontmatterDate({ lastmod: '2023-05-05' }, ['updated', 'lastmod'])?.getUTCFullYear()).toBe(2023)
  })

  it('ignores an unparseable date rather than emitting Invalid Date', () => {
    expect(resolveDates({ created: 'not a date' }, undefined, mtime).created).toEqual(mtime)
  })

  it('never reports an update older than the creation', () => {
    const d = resolveDates({ created: '2024-01-01', updated: '2020-01-01' }, undefined, mtime)
    expect(d.updated).toEqual(d.created)
  })
})

describe('excerpt', () => {
  it('takes the first real paragraph with markdown stripped', () => {
    const md = '---\ntitle: X\n---\n\n# Heading\n\nThe **first** _paragraph_ with a [link](x) and [[Wiki]].\n\nSecond.'
    expect(excerpt(md)).toBe('The first paragraph with a link and Wiki.')
  })

  it('prefers a wikilink alias over its target', () => {
    expect(excerpt('See [[private/Secret|the alias]].')).toBe('See the alias.')
  })

  it('drops code blocks, comments and embeds', () => {
    expect(excerpt('```\ncode\n```\n\n%%hidden%%\n\n![[img.png]]\n\nReal text.')).toBe('Real text.')
  })

  it('truncates on a word boundary', () => {
    const out = excerpt('word '.repeat(100), 50)
    expect(out.length).toBeLessThanOrEqual(51)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/wo…$/)
  })

  it('returns empty for a note with no prose', () => {
    expect(excerpt('---\ntitle: X\n---\n')).toBe('')
  })
})

describe('parseCallout', () => {
  it('parses a type and title', () => {
    const c = parseCallout('[!note] My Title')!
    expect(c.type).toBe('note')
    expect(c.title).toBe('My Title')
    expect(c.collapsible).toBe(false)
  })

  it('titles an untitled callout with its type label', () => {
    expect(parseCallout('[!warning]')!.title).toBe('Warning')
    expect(parseCallout('[!tldr]')!.title).toBe('TL;DR')
  })

  it('reads the collapse suffixes', () => {
    expect(parseCallout('[!note]- Closed')).toMatchObject({ collapsible: true, defaultOpen: false })
    expect(parseCallout('[!note]+ Open')).toMatchObject({ collapsible: true, defaultOpen: true })
  })

  it('is case-insensitive on the type', () => {
    expect(parseCallout('[!WARNING] x')!.type).toBe('warning')
  })

  it('keeps an unknown type instead of discarding it', () => {
    const c = parseCallout('[!custom-thing] x')!
    expect(c.type).toBe('custom-thing')
    expect(c.known).toBe(false)
  })

  it('returns undefined for an ordinary blockquote', () => {
    expect(parseCallout('Just a quote')).toBeUndefined()
    expect(parseCallout('[not a callout]')).toBeUndefined()
  })

  it('reports the marker length so the body can be sliced after it', () => {
    const line = '[!note] Title'
    expect(parseCallout(line)!.markerLength).toBe(line.length)
  })
})

describe('parseEmbedPipe: Obsidian size-vs-caption rule', () => {
  it('reads a bare number as a width', () => {
    expect(parseEmbedPipe('300')).toEqual({ width: 300 })
  })

  it('reads NxM as width and height', () => {
    expect(parseEmbedPipe('400x200')).toEqual({ width: 400, height: 200 })
  })

  it('reads anything else as a caption', () => {
    expect(parseEmbedPipe('A caption here')).toEqual({ caption: 'A caption here' })
    expect(parseEmbedPipe('300px')).toEqual({ caption: '300px' })
  })

  it('returns nothing for an absent pipe', () => {
    expect(parseEmbedPipe(undefined)).toEqual({})
    expect(parseEmbedPipe('  ')).toEqual({})
  })

  it('knows which targets are media rather than notes', () => {
    expect(isMediaTarget('diagram.png')).toBe(true)
    expect(isMediaTarget('clip.mp4')).toBe(true)
    expect(isMediaTarget('Note#Section')).toBe(false)
    expect(isMediaTarget('Some Note')).toBe(false)
  })
})

const SECTIONED = [
  '# Sections',
  '',
  'The opening of the whole note.',
  '',
  '## How it works',
  '',
  'Each note gets an address.',
  '',
  '## Nothing under here',
  '',
  '## Deeper',
  '',
  '### A sub-heading',
  '',
  'Still inside Deeper.',
  '',
  '## Last',
  '',
  'Closing text.',
  '',
  '```',
  '## Hidden',
  '',
  'Never a section.',
  '```',
].join('\n')

describe('sectionById', () => {
  it('returns the heading as written, not the slug it was found by', () => {
    expect(sectionById(SECTIONED, 'how-it-works')?.heading).toBe('How it works')
  })

  it('stops at the next heading of the same or higher level', () => {
    expect(sectionById(SECTIONED, 'how-it-works')?.body).toBe('Each note gets an address.')
  })

  it('keeps a deeper heading inside the section', () => {
    expect(sectionById(SECTIONED, 'deeper')?.body).toBe('### A sub-heading\n\nStill inside Deeper.')
  })

  it('runs to the end of the note for the last heading', () => {
    expect(sectionById(SECTIONED, 'last')?.body).toContain('Closing text.')
  })

  it('never matches a heading inside a code fence', () => {
    expect(sectionById(SECTIONED, 'hidden')).toBeUndefined()
  })

  it('tells an empty section apart from one that does not exist', () => {
    expect(sectionById(SECTIONED, 'nothing-under-here')).toEqual({
      heading: 'Nothing under here',
      body: '',
    })
    expect(sectionById(SECTIONED, 'nowhere')).toBeUndefined()
  })
})

describe('sectionOf', () => {
  it('takes a subpath as written and slugifies it', () => {
    expect(sectionOf(SECTIONED, '#How It WORKS')).toBe('Each note gets an address.')
  })

  it('resolves a block reference to the whole note, as v1 documented', () => {
    expect(sectionOf(SECTIONED, '#^abc123')).toBe(SECTIONED)
    expect(sectionOf(SECTIONED, '')).toBe(SECTIONED)
  })

  it('flattens both "missing" and "empty" to an empty string, as it always did', () => {
    expect(sectionOf(SECTIONED, '#Nowhere')).toBe('')
    expect(sectionOf(SECTIONED, '#Nothing under here')).toBe('')
  })

  it('does not understand Obsidian’s multi-level subpath', () => {
    expect(sectionOf(SECTIONED, '#Sections#How it works')).toBe('')
  })
})

describe('previewFor', () => {
  /** Only the three fields `previewFor` reads, filled the way the scan fills them. */
  const note = (body: string, title = 'Sections') =>
    ({ title, body, excerpt: excerpt(body) }) as VaultNote

  it('shows the note’s opening paragraph for a link with no subpath', () => {
    expect(previewFor(note(SECTIONED), '')).toEqual({
      title: 'Sections',
      text: 'The opening of the whole note.',
    })
  })

  it('shows the section’s opening for a heading link, and names it in the title', () => {
    expect(previewFor(note(SECTIONED), '#How it works')).toEqual({
      title: 'Sections > How it works',
      text: 'Each note gets an address.',
    })
  })

  it('accepts an already-slugified subpath, which is what a resolved href carries', () => {
    expect(previewFor(note(SECTIONED), '#how-it-works')?.text).toBe('Each note gets an address.')
  })

  it('previews the note’s opening for a block reference, matching sectionOf', () => {
    expect(previewFor(note(SECTIONED), '#^abc123')).toEqual({
      title: 'Sections',
      text: 'The opening of the whole note.',
    })
  })

  it('falls back to the note when the heading is missing, empty or fenced', () => {
    const whole = { title: 'Sections', text: 'The opening of the whole note.' }
    expect(previewFor(note(SECTIONED), '#Nowhere')).toEqual(whole)
    expect(previewFor(note(SECTIONED), '#Nothing under here')).toEqual(whole)
    expect(previewFor(note(SECTIONED), '#Hidden')).toEqual(whole)
  })

  it('gives up rather than offer a card with a blank body', () => {
    expect(previewFor(note('# Title only'), '')).toBeUndefined()
    expect(previewFor(note('# Title only'), '#Nowhere')).toBeUndefined()
  })

  it('memoizes per note and subpath', () => {
    const one = note(SECTIONED)
    expect(previewFor(one, '#How it works')).toBe(previewFor(one, '#How it works'))
    expect(previewFor(one, '')).not.toBe(previewFor(note(SECTIONED), ''))
  })
})

describe('normalizeResultUrl: Pagefind speaks in trailing slashes', () => {
  it('strips the trailing slash Pagefind puts on every page URL', () => {
    expect(normalizeResultUrl('/zettelkasten/')).toBe('/zettelkasten')
    expect(normalizeResultUrl('/method/progressive-summarisation/')).toBe(
      '/method/progressive-summarisation',
    )
  })

  it('leaves the homepage as the site spells it', () => {
    // The case that makes this more than a `replace`: trimming `/` would give
    // an empty href.
    expect(normalizeResultUrl('/')).toBe('/')
  })

  it('keeps the anchor a sub-result jumps to', () => {
    expect(normalizeResultUrl('/zettelkasten/#how-it-works')).toBe('/zettelkasten#how-it-works')
    expect(normalizeResultUrl('/#start-here')).toBe('/#start-here')
  })

  it('leaves a URL already spelled jotter’s way alone', () => {
    expect(normalizeResultUrl('/obsidian')).toBe('/obsidian')
    expect(normalizeResultUrl('/obsidian#links')).toBe('/obsidian#links')
  })

  /**
   * Pagefind indexes the **file path**, so a page in `dist/Wisdom+&+Approaches/`
   * is stored at the slug rather than at the URL. Without the re-encode a result
   * would be the one link on the site spelling that page differently from its
   * own canonical.
   */
  it('re-encodes a slug that carries a reserved character', () => {
    expect(normalizeResultUrl('/Wisdom+&+Approaches/Critical+Thinking/')).toBe(
      '/Wisdom+%26+Approaches/Critical+Thinking',
    )
    expect(normalizeResultUrl('/Wisdom+&+Approaches/Critical+Thinking/#why')).toBe(
      '/Wisdom+%26+Approaches/Critical+Thinking#why',
    )
  })

  it('survives a path Pagefind read off a file it cannot percent-decode', () => {
    expect(normalizeResultUrl('/100% done/')).toBe('/100%25%20done')
  })
})

describe('excerptParts: the excerpt is escaped HTML, not text', () => {
  const text = (data: string) => ({ nodeType: 3, nodeName: '#text', textContent: data })
  const mark = (data: string) => ({ nodeType: 1, nodeName: 'MARK', textContent: data })

  it('separates marked runs from unmarked ones', () => {
    expect(excerptParts([text('a note about '), mark('slipbox'), text(' methods')])).toEqual([
      { text: 'a note about ', mark: false },
      { text: 'slipbox', mark: true },
      { text: ' methods', mark: false },
    ])
  })

  it('trusts the parser to have decoded the entities', () => {
    // `&amp;` and `&#x27;` reach here already decoded, which is the whole
    // reason the caller parses rather than splitting the string on `<mark>`.
    expect(excerptParts([text("Luhmann & Ahrens' box")])).toEqual([
      { text: "Luhmann & Ahrens' box", mark: false },
    ])
  })

  it('drops anything that is neither text nor a mark', () => {
    const script = { nodeType: 1, nodeName: 'SCRIPT', textContent: 'alert(1)' }
    const img = { nodeType: 1, nodeName: 'IMG', textContent: '' }
    expect(excerptParts([text('before '), script, img, text('after')])).toEqual([
      { text: 'before after', mark: false },
    ])
  })

  it('merges adjacent runs of the same kind', () => {
    expect(excerptParts([text('one '), text('two'), mark('a'), mark('b')])).toEqual([
      { text: 'one two', mark: false },
      { text: 'ab', mark: true },
    ])
  })

  it('skips empty and null text without leaving empty parts', () => {
    expect(excerptParts([text(''), { nodeType: 3, nodeName: '#text', textContent: null }])).toEqual(
      [],
    )
    expect(excerptParts([])).toEqual([])
  })
})

describe('headingJumps: the sub-results worth showing', () => {
  const sub = (url: string, title = url) => ({ url, title })

  it('drops the sub-result that is only the page again', () => {
    // Pagefind always returns the page itself first, anchorless, and the
    // result's own link already is that.
    const subs = [sub('/zettelkasten/'), sub('/zettelkasten/#how-it-works')]
    expect(headingJumps(subs, '/zettelkasten', 3).map((s) => s.href)).toEqual([
      '/zettelkasten#how-it-works',
    ])
  })

  it('drops it wherever Pagefind puts it, not just first', () => {
    const subs = [sub('/a/#one'), sub('/a/'), sub('/a/#two')]
    expect(headingJumps(subs, '/a', 3).map((s) => s.href)).toEqual(['/a#one', '/a#two'])
  })

  it('collapses two sections that normalise to the same anchor', () => {
    const subs = [sub('/a/#dup'), sub('/a/#dup'), sub('/a/#other')]
    expect(headingJumps(subs, '/a', 5).map((s) => s.href)).toEqual(['/a#dup', '/a#other'])
  })

  it('caps the list, counting only what survived', () => {
    const subs = [sub('/a/'), sub('/a/#one'), sub('/a/#two'), sub('/a/#three')]
    expect(headingJumps(subs, '/a', 2).map((s) => s.href)).toEqual(['/a#one', '/a#two'])
  })

  it('keeps the caller’s own fields', () => {
    const subs = [{ url: '/a/#one', title: 'One', excerpt: 'text' }]
    expect(headingJumps(subs, '/a', 3)).toEqual([
      { url: '/a/#one', title: 'One', excerpt: 'text', href: '/a#one' },
    ])
  })

  it('handles a result with no sub-results at all', () => {
    expect(headingJumps(undefined, '/a', 3)).toEqual([])
    expect(headingJumps([], '/a', 3)).toEqual([])
    expect(headingJumps([sub('/a/')], '/a', 3)).toEqual([])
  })
})

describe('nextStop: arrow keys over the focus stops', () => {
  // Stops are [input, ...results], so a count of 4 is the field plus three.
  it('moves down and up without wrapping', () => {
    expect(nextStop(0, 4, 1)).toBe(1)
    expect(nextStop(2, 4, 1)).toBe(3)
    expect(nextStop(3, 4, 1)).toBe(3)
    expect(nextStop(2, 4, -1)).toBe(1)
    expect(nextStop(0, 4, -1)).toBe(0)
  })

  it('brings focus home to the field from elsewhere in the dialog', () => {
    // -1 is the close button, or the dialog itself.
    expect(nextStop(-1, 4, 1)).toBe(0)
    expect(nextStop(-1, 4, -1)).toBe(0)
  })

  it('has nowhere to go when there are no stops', () => {
    expect(nextStop(-1, 0, 1)).toBe(-1)
    expect(nextStop(0, 0, -1)).toBe(-1)
  })

  it('stays put when the field is the only stop', () => {
    expect(nextStop(0, 1, 1)).toBe(0)
    expect(nextStop(0, 1, -1)).toBe(0)
  })
})

describe('isTypingTarget, when Cmd+K should stand down', () => {
  it('recognises the fields a keystroke belongs to', () => {
    expect(isTypingTarget({ tagName: 'INPUT', isContentEditable: false })).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA', isContentEditable: false })).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT', isContentEditable: false })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('leaves the shortcut alone everywhere else', () => {
    expect(isTypingTarget({ tagName: 'BODY', isContentEditable: false })).toBe(false)
    expect(isTypingTarget({ tagName: 'A', isContentEditable: false })).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON', isContentEditable: false })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(undefined)).toBe(false)
  })

  it('is not fooled by a tag name that merely contains one', () => {
    expect(isTypingTarget({ tagName: 'INPUT-GROUP', isContentEditable: false })).toBe(false)
    expect(isTypingTarget({ tagName: 'MY-INPUT', isContentEditable: false })).toBe(false)
  })
})

describe('analyticsTag: the snippet each vendor documents', () => {
  const tag = (analytics: Parameters<typeof analyticsTag>[0]) => analyticsTag(analytics)!

  it('emits nothing when analytics is off', () => {
    expect(analyticsTag({ provider: 'none' })).toBeUndefined()
  })

  /**
   * The one that fails when someone adds a provider to the tuple and forgets to
   * give it a tag. Every other test here knows the answer it is checking; this
   * one only knows that there must *be* one.
   */
  it('has a tag for every provider the config accepts', () => {
    for (const provider of analyticsProviders) {
      if (provider === 'none') continue
      expect(analyticsTag({ provider, id: 'X' }), provider).toBeDefined()
    }
  })

  it('builds Plausible’s tag', () => {
    expect(tag({ provider: 'plausible', id: 'example.com' })).toEqual({
      src: 'https://plausible.io/js/script.js',
      attrs: { 'data-domain': 'example.com' },
      async: false,
    })
  })

  it('builds Umami’s tag, from the current cloud host', () => {
    // `analytics.umami.is`, which Quartz still ships, is stale.
    expect(tag({ provider: 'umami', id: 'abc-123' })).toEqual({
      src: 'https://cloud.umami.is/script.js',
      attrs: { 'data-website-id': 'abc-123', 'data-auto-track': 'true' },
      async: false,
    })
  })

  it('builds GoatCounter’s tag, async and over https', () => {
    // The documented snippet is protocol-relative `//gc.zgo.at/count.js`.
    expect(tag({ provider: 'goatcounter', id: 'mycode' })).toEqual({
      src: 'https://gc.zgo.at/count.js',
      attrs: { 'data-goatcounter': 'https://mycode.goatcounter.com/count' },
      async: true,
    })
  })

  it('builds Fathom’s tag', () => {
    expect(tag({ provider: 'fathom', id: 'ABCDEFG' })).toEqual({
      src: 'https://cdn.usefathom.com/script.js',
      attrs: { 'data-site': 'ABCDEFG' },
      async: false,
    })
  })

  it('builds Cloudflare’s tag with a real JSON token', () => {
    const attrs = tag({ provider: 'cloudflare', id: 'tok123' }).attrs
    expect(JSON.parse(attrs['data-cf-beacon'])).toEqual({ token: 'tok123' })
  })

  it('builds GA4’s two-tag snippet', () => {
    const out = tag({ provider: 'google', id: 'G-ABC1234567' })
    expect(out.src).toBe('https://www.googletagmanager.com/gtag/js?id=G-ABC1234567')
    expect(out.async).toBe(true)
    // The init block needs the id a second time; `Analytics.astro` passes it
    // through `define:vars` rather than interpolating it into a script body.
    expect(out.measurementId).toBe('G-ABC1234567')
  })

  it('never blocks paint, whichever provider is chosen', () => {
    for (const provider of analyticsProviders) {
      if (provider === 'none') continue
      const out = tag({ provider, id: 'X' })
      expect(out.src.startsWith('https://'), provider).toBe(true)
    }
  })

  it('sends the script to a self-hosted origin for the three that have one', () => {
    expect(tag({ provider: 'plausible', id: 'example.com', host: 'https://stats.example.com' }).src).toBe(
      'https://stats.example.com/js/script.js',
    )
    expect(tag({ provider: 'umami', id: 'abc-123', host: 'https://stats.example.com' }).src).toBe(
      'https://stats.example.com/script.js',
    )
    // GoatCounter self-hosts the *endpoint*, not the counting script.
    expect(tag({ provider: 'goatcounter', id: 'mycode', host: 'https://stats.example.com' }).attrs).toEqual({
      'data-goatcounter': 'https://stats.example.com/count',
    })
  })

  it('keeps the site’s own domain in data-domain when Plausible is self-hosted', () => {
    // The trap: `host` moves the script, never the identifier.
    const attrs = tag({ provider: 'plausible', id: 'example.com', host: 'https://stats.example.com' }).attrs
    expect(attrs['data-domain']).toBe('example.com')
  })

  it('joins a host rather than resolving against it', () => {
    // A reverse-proxied Plausible may live under a path prefix; `new URL()`
    // would throw the prefix away.
    expect(tag({ provider: 'plausible', id: 'a.com', host: 'https://example.com/proxy' }).src).toBe(
      'https://example.com/proxy/js/script.js',
    )
    expect(tag({ provider: 'plausible', id: 'a.com', host: 'https://example.com/' }).src).toBe(
      'https://example.com/js/script.js',
    )
  })

  it('ignores a host on the providers that have no self-hosted mode', () => {
    // The schema rejects this outright; the function stays total anyway.
    expect(tag({ provider: 'fathom', id: 'X', host: 'https://stats.example.com' }).src).toBe(
      'https://cdn.usefathom.com/script.js',
    )
  })

  it('emits nothing rather than half a tag when the id is missing', () => {
    // A gtag.js loader with no measurement id still pulls ~100 KB and records
    // nothing, so a partial tag is not inert.
    expect(analyticsTag({ provider: 'plausible' })).toBeUndefined()
    expect(analyticsTag({ provider: 'google' })).toBeUndefined()
  })
})
