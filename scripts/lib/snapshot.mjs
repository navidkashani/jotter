/**
 * Reading a published snapshot: fetch it, check it, and turn it into the two
 * things a vault directory needs — files at their addresses, and the link index
 * that says what every wikilink in them means.
 *
 * The half of this that the Quartz starter has and jotter does not need is the
 * link *rewriting*. Quartz cannot be told what a `[[wikilink]]` resolves to, so
 * that starter walks every note body, skips the protected ranges, and replaces
 * each link with a resolved `[label](/slug)` — two regexes, an offset
 * recomputation between passes, and the most delicate code in the whole
 * pipeline. jotter can be told: `src/lib/links-index.ts` already accepts the
 * manifest's own `{ links: {...} }` shape, and `IndexedLink` is field for field
 * the plugin's `SnapshotLink`. So the answers are written to
 * `<vault>/.jotter/links.json` and the note bodies are left exactly as their
 * author wrote them.
 */

import { parseDocument } from 'yaml'

import { sha256 } from './s3.mjs'

export const SNAPSHOT_VERSION = 1

/**
 * A path from the snapshot that would be written outside the vault directory.
 *
 * The same rule as `escapesOutputDir` in `src/lib/slug.ts`, for the same
 * reason: the plugin's slugifier cannot emit a traversal, but this script is
 * the one holding the pen, so it checks rather than assumes.
 */
export const escapesVault = (path) =>
  path.startsWith('/') || path.split('/').some((segment) => segment === '.' || segment === '..')

/** Leading and trailing slashes off, so `/a/` and `a` are the same address. */
export const stripSlashes = (value) => String(value ?? '').replace(/^\/+|\/+$/g, '')

/**
 * `current.json` -> `snapshots/<id>.json`, with the failure of each step
 * spelled out as something a person can act on.
 *
 * @param reader an `S3Reader`
 * @param fail   called with a message; must not return
 */
export async function readSnapshot(reader, fail) {
  const pointer = await reader.getJson('current.json')
  if (!pointer?.snapshot) {
    fail(
      'No content has been published yet: current.json is missing from the bucket.\n' +
        'Publish from the Obsidian plugin first, then trigger this build again.',
    )
  }

  const snapshot = await reader.getJson(`snapshots/${pointer.snapshot}.json`)
  if (!snapshot) {
    fail(
      `current.json points at snapshot "${pointer.snapshot}", but that snapshot is not in the ` +
        'bucket.\nIt may have been removed by a cleanup. Publish again from Obsidian to write a ' +
        'fresh snapshot.',
    )
  }
  if (snapshot.version !== SNAPSHOT_VERSION) {
    fail(
      `This starter understands snapshot version ${SNAPSHOT_VERSION}, but the bucket holds ` +
        `version ${snapshot.version}.\nUpdate this repository from the jotter template.`,
    )
  }

  return { pointer, snapshot }
}

/** The object key a file's content lives at. Mirrors the plugin's `objectKey`. */
export const objectKey = (hash) => `objects/${hash.slice(0, 2)}/${hash}`

/**
 * Everything about one entry that must be true before it is written anywhere,
 * as a message, or `undefined`.
 *
 * Returned rather than thrown so the caller decides how to stop, and so the
 * checks can be tested without a bucket or a process to exit.
 */
export function entryProblem(path, file, redirectFroms = []) {
  if (escapesVault(path)) {
    return `The snapshot lists "${path}", a path that escapes the vault directory.`
  }
  if (typeof file?.slug !== 'string' || !file.slug) {
    return `The snapshot entry for "${path}" has no slug, so there is nowhere to write it.`
  }
  // Without a hash there is no object to fetch and nothing to check the bytes
  // against, which are the two things this whole pipeline is for.
  if (typeof file.hash !== 'string' || !/^[0-9a-f]{64}$/.test(file.hash)) {
    return `The snapshot entry for "${path}" has no usable sha256, so its content cannot be verified.`
  }
  if (escapesVault(file.slug)) {
    return `The snapshot entry for "${path}" has a slug that escapes the vault directory: ${file.slug}`
  }
  // Old addresses become redirect sources, one step further from this script
  // than the slug is, so they get the identical check.
  for (const url of legacyUrlsOf(file)) {
    if (escapesVault(url)) {
      return `The snapshot entry for "${path}" has an old URL that escapes the vault directory: ${url}`
    }
  }
  for (const from of redirectFroms) {
    if (escapesVault(from)) {
      return `A redirect to "${file.slug}" comes from a path that escapes the vault directory: ${from}`
    }
  }
  return undefined
}

const legacyUrlsOf = (file) =>
  (file?.legacyUrls ?? []).filter((url) => typeof url === 'string' && url.length > 0)

/** The raw `from` of every rename the plugin has recorded pointing at this slug. */
export function redirectFromsFor(slug, redirects = []) {
  return (Array.isArray(redirects) ? redirects : [])
    .filter((rule) => rule && stripSlashes(rule.to) === slug)
    .map((rule) => String(rule.from ?? ''))
    .filter(Boolean)
}

/**
 * The old addresses that should 301 to this note: the ones the plugin recorded
 * on the file, plus every rename it has seen since.
 *
 * These become `aliases:` rather than `permalink:`, and that decision is the
 * whole of why this layer needs no redirect writer of its own.
 * `buildRedirects` runs an alias through `sourceFor(alias, 'preserve')` — NFC
 * and nothing else — and then through the single `encodeSlug` at
 * `src/lib/redirects.ts:105`, so `Wisdom+&+Approaches/Critical+Thinking`
 * arrives at `/Wisdom+%26+Approaches/Critical+Thinking` as a 301 **and the
 * note does not move**. Writing them to `permalink:` would move it: the first
 * permalink is where a note is *served*, so the address the plugin published
 * would 301 to the address the site used to have, backwards.
 */
export function oldAddressesFor(file, slug, redirects = []) {
  return [
    ...new Set(
      [...legacyUrlsOf(file), ...redirectFromsFor(slug, redirects)]
        .map(stripSlashes)
        .filter(Boolean),
    ),
  ]
}

/**
 * `snapshot.links`, re-keyed from vault path to the path the note is written at.
 *
 * This is not cosmetic. `src/lib/links-index.ts:42` keys every lookup on the
 * note's own on-disk path, and `resolve.ts:109` passes exactly that — which
 * here is `<slug>.md`, not the vault path the manifest used. Left un-re-keyed,
 * every lookup would miss, the index would silently do nothing, and jotter
 * would fall back to guessing at links the plugin had already answered.
 *
 * @returns {Record<string, unknown[]>}
 */
export function reKeyLinks(snapshot) {
  /** @type {Record<string, unknown[]>} */
  const links = {}
  for (const [path, entries] of Object.entries(snapshot?.links ?? {})) {
    const slug = snapshot?.files?.[path]?.slug
    if (!slug || !Array.isArray(entries)) continue
    links[`${slug}.md`] = entries
  }
  return links
}

/** YAML double-quoted scalars accept JSON escaping. */
const quote = (value) => JSON.stringify(String(value))

const hasKey = (lines, key) => lines.some((line) => new RegExp(`^${key}\\s*:`).test(line))

/**
 * Carry the snapshot's resolved title and the note's full set of names into its
 * frontmatter.
 *
 * Files are written at their slug, so without the snapshot's title jotter would
 * name every page after its URL — "cafe-resume", and the homepage "index". The
 * plugin has already worked the real one out (frontmatter `title`, else the
 * first H1, else the filename), so it is copied rather than re-derived.
 *
 * **What the author wrote wins.** A note with its own `title:` is left alone.
 * `aliases` is the one key that is *merged* rather than skipped, and that is
 * not an exception to the rule: the snapshot's `aliases` are read out of this
 * note's own frontmatter by the plugin, so the merged list is a superset of
 * what the author typed, never a replacement for it. The old addresses have to
 * join that list — dropping them because the author happened to keep an alias
 * of their own is how a legacy URL silently stops answering.
 *
 * The common case — no `aliases:` key yet — is a line insertion, which touches
 * nothing else in the file. Only the merge needs a parse.
 */
export function applyNoteMetadata(text, meta = {}, warnings = []) {
  const aliases = [...new Set((meta.aliases ?? []).map((a) => String(a)).filter(Boolean))]
  const lines = text.split('\n')

  if (lines[0]?.trim() !== '---') {
    const additions = []
    if (meta.title) additions.push(`title: ${quote(meta.title)}`)
    if (aliases.length > 0) additions.push(`aliases: [${aliases.map(quote).join(', ')}]`)
    return additions.length === 0 ? text : ['---', ...additions, '---', '', text].join('\n')
  }

  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i
      break
    }
  }
  // Unterminated frontmatter is the author's problem, not ours to rewrite.
  if (close === -1) return text

  const block = lines.slice(1, close)
  const merging = aliases.length > 0 && (hasKey(block, 'aliases') || hasKey(block, 'alias'))

  if (!merging) {
    const additions = []
    if (meta.title && !hasKey(block, 'title')) additions.push(`title: ${quote(meta.title)}`)
    if (aliases.length > 0) additions.push(`aliases: [${aliases.map(quote).join(', ')}]`)
    if (additions.length === 0) return text
    return [...lines.slice(0, close), ...additions, ...lines.slice(close)].join('\n')
  }

  const doc = parseDocument(block.join('\n'))
  if (doc.errors.length > 0) {
    // jotter's own scan survives malformed YAML (`src/lib/vault.ts:132`) and so
    // does this: the note keeps every alias it had, and loses only the ones
    // this pass wanted to add. Said out loud, because a legacy URL that stopped
    // answering is not something to discover from a 404.
    warnings.push(
      `frontmatter could not be parsed (${doc.errors[0].message}), so its old addresses ` +
        `were not added as aliases`,
    )
    return text
  }

  const key = doc.has('aliases') || !doc.has('alias') ? 'aliases' : 'alias'
  const existing = doc.toJS()?.[key]
  const kept = (Array.isArray(existing) ? existing : existing == null ? [] : [existing])
    .map((value) => String(value))
    .filter(Boolean)
  doc.set(key, [...kept, ...aliases.filter((alias) => !kept.includes(alias))])
  if (meta.title && !doc.has('title')) doc.set('title', String(meta.title))

  return ['---', doc.toString().replace(/\n$/, ''), ...lines.slice(close)].join('\n')
}

/** Bounded concurrency over a list, in order, with no dependency on p-limit. */
export async function pool(items, limit, worker) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = next++
        if (index >= items.length) return
        await worker(items[index], index)
      }
    }),
  )
}

export { sha256 }
