import { describe, expect, it } from 'vitest'

import { protectedRanges, isProtected, anchorFor } from '../src/lib/protected.js'
import { slugifyPath, slugifySegment, assignSlugs, slugifyHeading } from '../src/lib/slug.js'
import { mergeTags, inlineTags, frontmatterTags, expandTag, tagTree, normalizeTag } from '../src/lib/tags.js'
import { resolveDates, frontmatterDate } from '../src/lib/dates.js'
import { excerpt } from '../src/lib/excerpt.js'
import { parseCallout } from '../src/lib/callout.js'
import { parseEmbedPipe, isMediaTarget } from '../src/lib/embed.js'

describe('protectedRanges — parity with open-publish rewrite.mjs', () => {
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

describe('parseEmbedPipe — Obsidian size-vs-caption rule', () => {
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
