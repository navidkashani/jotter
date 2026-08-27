/**
 * The filesystem scan that makes the whole pipeline possible.
 *
 * The ordering problem: wikilinks must resolve *during* markdown render, but
 * Astro's `getCollection()` is only available *after*. A markdown plugin cannot
 * call it. So this module reads the vault directly, at config load, with Node
 * `fs` and a YAML parse, and hands the same index to both `astro.config.ts`
 * (which builds the plugins' resolver) and every page (for graph, backlinks and
 * tags). Synchronous and memoized, so a 1,000-note vault is scanned once.
 *
 * This is also the one place jotter hand-rolls wikilink detection, deliberately:
 * it has to run before a processor exists. Everywhere else Satteri parses.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { protectedRanges, isProtected } from './protected.js'
import { assignSlugs } from './slug.js'
import { mergeTags } from './tags.js'
import { gitDates, resolveDates, type NoteDates } from './dates.js'
import { excerpt } from './excerpt.js'
import { svgIntrinsicSize } from './embed.js'
import { loadLinksIndex, type LinkOverrides } from './links-index.js'
import type { ResolvableNote, VaultIndex } from './resolve.js'

export interface LinkEdge {
  /** Target exactly as written, including any `#subpath`. */
  raw: string
  /** Explicit `|alias`, when given. */
  alias?: string
  embed: boolean
  wikilink: boolean
}

export interface VaultNote extends ResolvableNote {
  frontmatter: Record<string, unknown>
  /** Raw markdown with frontmatter removed. */
  body: string
  tags: string[]
  dates: NoteDates
  excerpt: string
  /** Byte offset of the body within the file, so positions can be mapped back. */
  bodyOffset: number
}

export interface Vault extends VaultIndex<VaultNote> {
  root: string
  notes: VaultNote[]
  bySlug: Map<string, VaultNote>
  /** Intrinsic size for assets Astro's image pipeline will not measure (SVG). */
  assetSizes: Map<string, { width: number; height: number }>
  linkOverrides?: LinkOverrides
  /** Outgoing links per note path, in document order. */
  edges: Map<string, LinkEdge[]>
  warnings: string[]
}

export type PublishGate = 'all' | 'opt-in'

export interface ScanOptions {
  root: string
  publishGate?: PublishGate
  /** Directory names skipped wholesale. */
  ignore?: readonly string[]
  /**
   * `config.homepage`: the note that should claim `/`, named by slug, by vault
   * path or by filename.
   *
   * Part of the memo key below, which makes passing it non-optional in
   * practice: both callers (`src/lib/site.ts` and `astro.config.ts`) must pass
   * it or the build scans the vault twice and the two scans disagree about
   * which note owns `/`.
   */
  homepage?: string
}

const DEFAULT_IGNORE = ['node_modules', '.git', '.obsidian', '.trash', '.jotter']

const WIKILINK = /(!?)\[\[([^[\]]+?)\]\]/g
const MARKDOWN_LINK = /(!?)\[([^\]]*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:\s+"[^"]*")?\)/g

const cache = new Map<string, Vault>()

/** Split frontmatter from body without a full markdown parse. */
export function splitFrontmatter(source: string): {
  frontmatter: Record<string, unknown>
  body: string
  bodyOffset: number
} {
  if (!source.startsWith('---')) return { frontmatter: {}, body: source, bodyOffset: 0 }
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
  if (!match) return { frontmatter: {}, body: source, bodyOffset: 0 }

  let frontmatter: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(match[1])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>
    }
  } catch {
    // Malformed YAML is not a reason to drop a note. The note renders; the
    // frontmatter is simply absent, which every downstream field tolerates.
  }
  return { frontmatter, body: source.slice(match[0].length), bodyOffset: match[0].length }
}

/** Outgoing links from raw markdown, skipping code fences and inline code. */
export function extractEdges(body: string): LinkEdge[] {
  const ranges = protectedRanges(body)
  const edges: LinkEdge[] = []

  WIKILINK.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WIKILINK.exec(body)) !== null) {
    if (isProtected(ranges, match.index)) continue
    const inner = match[2]
    const pipe = inner.indexOf('|')
    const raw = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
    if (!raw || raw.startsWith('#')) continue // in-note anchor
    edges.push({
      raw,
      ...(pipe === -1 ? {} : { alias: inner.slice(pipe + 1).trim() }),
      embed: match[1] === '!',
      wikilink: true,
    })
  }

  MARKDOWN_LINK.lastIndex = 0
  while ((match = MARKDOWN_LINK.exec(body)) !== null) {
    if (isProtected(ranges, match.index)) continue
    const target = match[3]
    // External, protocol-relative, in-page anchor, or already site-absolute.
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(target)) continue
    edges.push({
      raw: target,
      ...(match[2] ? { alias: match[2] } : {}),
      embed: match[1] === '!',
      wikilink: false,
    })
  }

  return edges
}

/** A note is published unless it opts out, or unless the gate makes it opt in. */
export function isPublished(frontmatter: Record<string, unknown>, gate: PublishGate): boolean {
  if (frontmatter.draft === true) return false
  const publish = frontmatter.publish
  if (publish === false) return false
  if (gate === 'opt-in') return publish === true
  return true
}

/** Title precedence: frontmatter -> first H1 -> filename. */
export function resolveTitle(
  frontmatter: Record<string, unknown>,
  body: string,
  filename: string,
): string {
  const fm = frontmatter.title
  if (typeof fm === 'string' && fm.trim()) return fm.trim()
  if (typeof fm === 'number') return String(fm)

  const ranges = protectedRanges(body)
  const h1 = /^[ \t]{0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body)
  if (h1 && !isProtected(ranges, h1.index)) return h1[1].trim()

  return filename
}

function walk(dir: string, ignore: readonly string[], out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ignore.includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, ignore, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

export function scanVault(options: ScanOptions): Vault {
  const key = JSON.stringify(options)
  const cached = cache.get(key)
  if (cached) return cached

  const { root, publishGate = 'all', ignore = DEFAULT_IGNORE, homepage } = options
  const warnings: string[] = []

  if (!existsSync(root)) {
    const empty = emptyVault(root, [`Vault directory not found: ${root}`])
    cache.set(key, empty)
    return empty
  }

  const files = walk(root, ignore).map((f) => relative(root, f).split(sep).join('/')).sort()
  const markdown = files.filter((f) => /\.md$/i.test(f))
  const assetPaths = files.filter((f) => !/\.(md|mdx)$/i.test(f))

  const { slugs, collisions } = assignSlugs(markdown)
  for (const { slug, paths } of collisions) {
    warnings.push(
      `Slug collision on "${slug}": ${paths.join(', ')}. ` +
        `Kept "${paths[0]}"; the rest were suffixed. Rename one to choose deliberately.`,
    )
  }

  const git = gitDates(root)
  const notes: VaultNote[] = []
  const edges = new Map<string, LinkEdge[]>()

  for (const path of markdown) {
    const full = join(root, path)
    let source: string
    try {
      source = readFileSync(full, 'utf8')
    } catch (error) {
      warnings.push(`Could not read ${path}: ${(error as Error).message}`)
      continue
    }

    const { frontmatter, body, bodyOffset } = splitFrontmatter(source)
    const filename = (path.split('/').pop() ?? path).replace(/\.md$/i, '')
    const aliases = normalizeAliases(frontmatter.aliases ?? frontmatter.alias)

    notes.push({
      path,
      slug: slugs.get(path) ?? path,
      filename,
      title: resolveTitle(frontmatter, body, filename),
      aliases,
      published: isPublished(frontmatter, publishGate),
      frontmatter,
      body,
      bodyOffset,
      tags: mergeTags(frontmatter.tags, body),
      dates: resolveDates(frontmatter, git.get(path), statSync(full).mtime),
      excerpt: excerpt(body),
    })
    edges.set(path, extractEdges(body))
  }

  claimRoot(notes, homepage, warnings)

  const linkOverrides = loadLinksIndex(root, warnings)
  if (linkOverrides) {
    warnings.push(
      `Using .jotter/links.json (${linkOverrides.size} entries). It overrides ` +
        `linkResolution for every link it names.`,
    )
  }

  const vault: Vault = {
    root,
    notes,
    edges,
    warnings,
    assetSizes: measureAssets(root, assetPaths),
    linkOverrides,
    ...buildIndex(notes, assetPaths, warnings),
  }
  cache.set(key, vault)
  return vault
}

/** SVGs only: everything else Astro measures itself. */
function measureAssets(
  root: string,
  assetPaths: readonly string[],
): Map<string, { width: number; height: number }> {
  const sizes = new Map<string, { width: number; height: number }>()
  for (const path of assetPaths) {
    if (!/\.svg$/i.test(path)) continue
    try {
      const size = svgIntrinsicSize(readFileSync(join(root, path), 'utf8'))
      if (size) sizes.set(path, size)
    } catch {
      // An unreadable asset is already reported when a note tries to embed it.
    }
  }
  return sizes
}

function normalizeAliases(value: unknown): string[] {
  if (value == null) return []
  const list = Array.isArray(value) ? value : [value]
  return [...new Set(list.map((a) => String(a).trim()).filter(Boolean))]
}

function buildIndex(
  notes: readonly VaultNote[],
  assetPaths: readonly string[],
  warnings: string[],
): Pick<Vault, 'byPath' | 'byFilename' | 'byAlias' | 'assets' | 'bySlug'> {
  const byPath = new Map<string, VaultNote>()
  const bySlug = new Map<string, VaultNote>()
  const byFilename = new Map<string, VaultNote[]>()
  const byAlias = new Map<string, VaultNote[]>()
  const assets = new Map<string, string[]>()

  for (const note of notes) {
    const lower = note.path.toLowerCase()
    // Both forms, so `[[folder/Note]]` and `[[folder/Note.md]]` both hit.
    byPath.set(lower, note)
    byPath.set(lower.replace(/\.md$/, ''), note)
    bySlug.set(note.slug, note)
    push(byFilename, note.filename.toLowerCase(), note)
    for (const alias of note.aliases) push(byAlias, alias.toLowerCase(), note)
  }

  // An alias that shadows a real filename never wins: filename lookup runs
  // first in `resolveLink`. Warn, because the author probably did not mean it.
  for (const [alias, claimants] of byAlias) {
    if (byFilename.has(alias)) {
      warnings.push(
        `Alias "${alias}" (on ${claimants.map((c) => c.path).join(', ')}) collides with a real ` +
          `note filename. The real note wins; the alias is unreachable.`,
      )
    } else if (claimants.length > 1) {
      warnings.push(
        `Alias "${alias}" is claimed by ${claimants.map((c) => c.path).join(', ')}. ` +
          `Resolving to the shallowest.`,
      )
    }
  }

  for (const path of assetPaths) {
    const lower = path.toLowerCase()
    push(assets, lower, path)
    push(assets, (lower.split('/').pop() ?? lower), path)
  }

  return { byPath, bySlug, byFilename, byAlias, assets }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key)
  if (existing) existing.push(value)
  else map.set(key, [value])
}

function emptyVault(root: string, warnings: string[]): Vault {
  return {
    root,
    notes: [],
    edges: new Map(),
    warnings,
    byPath: new Map(),
    bySlug: new Map(),
    assetSizes: new Map(),
    byFilename: new Map(),
    byAlias: new Map(),
    assets: new Map(),
  }
}

/**
 * Give the note that claims `/` the slug `index`, because that is already how
 * jotter spells "this note lives at the root".
 *
 * `noteHref('index')` returns `/`, and it has since the first commit. So the
 * whole of "the homepage note is linked as `/`" falls out of renaming one
 * field: every `noteHref` call site, the graph and backlinks (keyed by slug),
 * the redirect `taken` list, the search index and the feed are then correct for
 * the same reason a root `index.md` already was. The alternative — teaching
 * seventeen call sites about a homepage — means either a parameter threaded
 * through all of them or module state in `src/lib/href.ts`, whose whole point
 * is that there is one stateless answer to what a link looks like.
 *
 * Runs after the note loop and before `buildIndex()`, which is the first point
 * where frontmatter is known and the last before `bySlug` is built from these
 * slugs. `assignSlugs` cannot do this: it runs on paths alone, before a single
 * file has been read.
 *
 * Precedence: `config.homepage` > frontmatter `homepage: true` > `index.md`.
 * Unpublished notes never qualify, so a `homepage:` naming one falls through to
 * the next candidate exactly as a `homepage:` naming nothing does.
 */
function claimRoot(notes: VaultNote[], homepage: string | undefined, warnings: string[]): void {
  const published = notes.filter((n) => n.published)

  // Three lookups rather than one predicate, so slug beats path beats filename
  // instead of whichever note happens to sort first.
  let claimant = homepage
    ? (published.find((n) => n.slug === homepage) ??
      published.find((n) => n.path === homepage) ??
      published.find((n) => n.filename === homepage))
    : undefined

  if (!claimant) {
    // `notes` is in sorted path order, so the winner does not depend on
    // filesystem enumeration — the same rule `assignSlugs` breaks ties by.
    const flagged = published.filter((n) => n.frontmatter.homepage === true)
    if (flagged.length > 1) {
      warnings.push(
        `More than one note sets \`homepage: true\`: ${flagged.map((n) => n.path).join(', ')}. ` +
          `Using "${flagged[0].path}". Remove the flag from the rest, or name one in \`homepage:\`.`,
      )
    }
    claimant = flagged[0]
  }

  // No claimant, or the note already at the root: nothing to rename. This is
  // the committed default, and it must cost nothing.
  if (!claimant || claimant.slug === 'index') return

  /**
   * Two notes claim `/` and only one can have it. Config wins, and the other
   * keeps a page under a suffixed slug — the same choice, for the same reason,
   * as `src/pages/[...slug].astro` making a note beat a folder of the same
   * name: silently dropping either would be worse than either choice.
   */
  const incumbent = notes.find((n) => n.slug === 'index')
  if (incumbent) {
    const taken = new Set(notes.map((n) => n.slug))
    let n = 2
    let slug = `index-${n}`
    while (taken.has(slug)) slug = `index-${++n}`
    incumbent.slug = slug
    // Renamed either way, so `bySlug` cannot hold two notes at `index` — but
    // only *reported* when the displaced note is published, because an
    // unpublished one never claimed `/` and its slug is observable nowhere.
    if (incumbent.published) {
      warnings.push(
        `Both "${incumbent.path}" and "${claimant.path}" claim "/". ` +
          `"${claimant.path}" wins; "${incumbent.path}" is served at "/${slug}" instead. ` +
          `Rename one, or drop \`homepage\`, to choose deliberately.`,
      )
    }
  }

  claimant.slug = 'index'
}

/** Testing seam: the scan is memoized for the life of the process. */
export const clearVaultCache = (): void => void cache.clear()
