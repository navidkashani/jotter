/**
 * Obsidian-compatible link resolution.
 *
 * This is the one thing jotter claims that Quartz does not. Quartz's
 * `CrawlLinks` defaults `markdownLinkResolution` to `absolute`; Obsidian's own
 * default is *shortest path*. A vault written against Obsidian's default and
 * published through Quartz's gets links that worked in the app and 404 on the
 * site. jotter defaults to `shortest`.
 *
 * Pure: it knows nothing about Sätteri, Astro or the filesystem. It takes an
 * index and a target string and answers. That is what makes it testable against
 * a hostile fixture vault.
 */

export type LinkResolution = 'shortest' | 'absolute' | 'relative'

export interface ResolvableNote {
  /** Vault-relative path, e.g. `Notes/Zettelkasten.md`. */
  path: string
  slug: string
  /** Basename without extension, e.g. `Zettelkasten`. */
  filename: string
  title: string
  aliases: string[]
  published: boolean
}

export interface VaultIndex<N extends ResolvableNote = ResolvableNote> {
  /**
   * `.jotter/links.json`, when the vault ships one. Present means the answer
   * was already computed by something that could see the *whole* vault, so it
   * wins over anything this module could work out from the published subset.
   */
  linkOverrides?: {
    lookup(fromPath: string, raw: string): { status: string; slug?: string; subpath?: string } | undefined
  }
  /** Lowercased vault-relative path (with *and* without `.md`) -> note. */
  byPath: Map<string, N>
  /** Lowercased basename -> every note with that basename. Ambiguity is real. */
  byFilename: Map<string, N[]>
  /** Lowercased alias -> every note claiming it. */
  byAlias: Map<string, N[]>
  /** Lowercased basename and full path -> asset paths (images, pdfs, ...). */
  assets: Map<string, string[]>
  /** Slug -> note, used to honour a `.jotter/links.json` entry. */
  bySlug?: Map<string, N>
}

export type Resolution<N extends ResolvableNote = ResolvableNote> =
  | {
      status: 'published' | 'unpublished'
      note: N
      anchor: string
      /** Set when more than one note matched; both names are reported. */
      ambiguity?: N[]
    }
  | { status: 'unresolved'; note?: undefined; anchor: string; ambiguity?: undefined }

/** Split `folder/Note#Heading` into its path and subpath halves. */
export function splitTarget(raw: string): { path: string; subpath: string } {
  const hash = raw.indexOf('#')
  if (hash === -1) return { path: raw.trim(), subpath: '' }
  return { path: raw.slice(0, hash).trim(), subpath: raw.slice(hash).trim() }
}

const dirOf = (path: string) => {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

const baseOf = (path: string) => {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/** Collapse `.` and `..` without touching the filesystem. */
function normalizeJoin(dir: string, rel: string): string {
  const out: string[] = dir ? dir.split('/') : []
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

const stripExt = (p: string) => p.replace(/\.md$/i, '')

/**
 * Obsidian's tiebreak when several notes share a basename: the shallowest path
 * wins, and equal depths are broken alphabetically so the choice does not
 * depend on directory enumeration order.
 */
function shallowest<N extends ResolvableNote>(candidates: readonly N[]): N {
  return [...candidates].sort((a, b) => {
    const depth = a.path.split('/').length - b.path.split('/').length
    return depth !== 0 ? depth : a.path.localeCompare(b.path)
  })[0]
}

/**
 * Resolve a wikilink or relative markdown link target to a note.
 *
 * @param raw       the link target as written, e.g. `folder/Note#Heading`
 * @param fromPath  vault-relative path of the note containing the link
 */
export function resolveLink<N extends ResolvableNote>(
  raw: string,
  fromPath: string,
  index: VaultIndex<N>,
  mode: LinkResolution = 'shortest',
): Resolution<N> {
  const { path: targetPath, subpath } = splitTarget(raw)
  const anchor = subpath

  const override = index.linkOverrides?.lookup(fromPath, raw)
  if (override) {
    if (override.status !== 'published' || !override.slug) {
      return { status: 'unresolved', anchor }
    }
    const note = index.bySlug?.get(override.slug)
    if (note) return { status: 'published', note, anchor: override.subpath ?? anchor }
    // The index named a slug this build does not have. Fall through rather
    // than emit a link to a page that will not exist.
  }

  // A bare `#heading` points inside the current note.
  if (!targetPath) {
    const self = index.byPath.get(fromPath.toLowerCase())
    return self
      ? { status: self.published ? 'published' : 'unpublished', note: self, anchor }
      : { status: 'unresolved', anchor }
  }

  let decoded = targetPath
  try {
    decoded = decodeURIComponent(targetPath)
  } catch {
    // A malformed escape sequence is not ours to fix; match the raw form.
  }
  const norm = stripExt(decoded.replace(/^\.\//, '')).toLowerCase()

  const byExactPath = () => index.byPath.get(norm)
  const byRelativePath = () => index.byPath.get(normalizeJoin(dirOf(fromPath), norm).toLowerCase())
  const byFilename = () => index.byFilename.get(baseOf(norm)) ?? []
  const byAlias = () => index.byAlias.get(norm) ?? []

  /**
   * Order differs per mode only in where a *path-shaped* target is looked up
   * first. Filename and alias matching are Obsidian behaviours that stay on in
   * every mode — turning them off would break links that work in the app.
   */
  const lookups =
    mode === 'relative'
      ? [byRelativePath, byExactPath]
      : mode === 'absolute'
        ? [byExactPath]
        : [byExactPath, byRelativePath]

  for (const lookup of lookups) {
    const hit = lookup()
    if (hit) return { status: hit.published ? 'published' : 'unpublished', note: hit, anchor }
  }

  for (const candidates of [byFilename(), byAlias()]) {
    if (candidates.length === 0) continue
    const note = candidates.length === 1 ? candidates[0] : shallowest(candidates)
    return {
      status: note.published ? 'published' : 'unpublished',
      note,
      anchor,
      ...(candidates.length > 1 ? { ambiguity: candidates } : {}),
    }
  }

  return { status: 'unresolved', anchor }
}

/** Resolve an embed target that is an asset rather than a note. */
export function resolveAsset(
  raw: string,
  fromPath: string,
  index: Pick<VaultIndex, 'assets'>,
): string | undefined {
  const { path: targetPath } = splitTarget(raw)
  if (!targetPath) return undefined
  let decoded = targetPath
  try {
    decoded = decodeURIComponent(targetPath)
  } catch {
    /* compare the raw form */
  }
  const norm = decoded.replace(/^\.\//, '').toLowerCase()
  const tries = [norm, normalizeJoin(dirOf(fromPath), norm).toLowerCase(), baseOf(norm)]
  for (const key of tries) {
    const hits = index.assets.get(key)
    if (hits?.length) return [...hits].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0]
  }
  return undefined
}

/**
 * The label for a *dead* link: the last path segment, without its extension.
 *
 * It must never reach for a note's title. A note excluded from the site must
 * not have its title leak into the published HTML through a link somebody else
 * wrote to it — and the basename keeps the folder it sits in out of the page
 * too.
 */
export function displayFor(raw: string, alias?: string): string {
  if (alias) return alias
  const { path, subpath } = splitTarget(raw)
  const base = stripExt(baseOf(path))
  if (subpath && !subpath.startsWith('#^')) return `${base || path} > ${subpath.slice(1)}`
  return base || path || raw
}

/**
 * The label for a *resolved* link with no alias, exactly as Obsidian renders
 * it: the target as the author wrote it, with the heading separator spelled
 * `>` rather than `#`. Unlike {@link displayFor} the path is kept, because for
 * a published note it is information rather than a leak.
 */
export function liveLabel(raw: string): string {
  const { path, subpath } = splitTarget(raw)
  const shown = stripExt(path)
  if (!subpath || subpath.startsWith('#^')) return shown || raw
  return `${shown} > ${subpath.slice(1)}`
}
