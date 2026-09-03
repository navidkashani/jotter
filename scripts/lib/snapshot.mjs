/**
 * Reading a published snapshot: fetch it, check it, and turn it into the two
 * things a vault directory needs: files at their addresses, and the link index
 * that says what every wikilink in them means.
 *
 * The half of this that the Quartz starter has and jotter does not need is the
 * link *rewriting*. Quartz cannot be told what a `[[wikilink]]` resolves to, so
 * that starter walks every note body, skips the protected ranges, and replaces
 * each link with a resolved `[label](/slug)`: two regexes, an offset
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
 * The old addresses that should redirect to this note, **as two keys**: the
 * ones the plugin recorded on the file, and every rename it has seen since.
 *
 * These become frontmatter rather than `permalink:`, and that decision is the
 * whole of why this layer needs no redirect writer of its own.
 * `buildRedirectRules` runs an old address through `sourceFor(url, 'preserve')`
 * (NFC and nothing else), and then through the single `encodeSlug` at the end
 * of that function, so `Wisdom+&+Approaches/Critical+Thinking` arrives at
 * `/Wisdom+%26+Approaches/Critical+Thinking` as a redirect **and the note does
 * not move**. Writing them to `permalink:` would move it: the first permalink
 * is where a note is *served*, so the address the plugin published would
 * redirect to the address the site used to have, backwards.
 *
 * And keys of their own rather than `aliases:`, which is where these used to
 * go. All of them become redirects, so routing was never the difference;
 * display was. `src/components/Frontmatter.astro` prints `aliases` on the page
 * under "Also known as", so every note on a vault migrated from Obsidian
 * Publish showed a `+`-encoded routing artifact as human metadata. An alias is
 * a name the author gave the note. This is a URL somebody published.
 *
 * **Two keys and not one**, which is the only thing downstream cannot work out
 * for itself. `legacyUrls` is what publish.obsidian.md served: frozen, and
 * `oldUrls:` keeps its `301`. A rename is this site's own history and reverses
 * the moment the note is renamed back, so it goes to `renamedFrom:` and gets a
 * `302`. Merged into one list they were indistinguishable, every rule was
 * `301`, and a retracted one left browsers looping between two builds' answers.
 * See `RedirectRule` in `src/lib/redirects.ts`.
 *
 * An address that is both is written once, under the stronger key.
 *
 * @returns {{oldUrls: string[], renamedFrom: string[]}} spread straight into
 *   `applyNoteMetadata`'s `meta`, whose keys these are.
 */
export function oldAddressesFor(file, slug, redirects = []) {
  const clean = (values) => [...new Set(values.map(stripSlashes).filter(Boolean))]
  const oldUrls = clean(legacyUrlsOf(file))
  return {
    oldUrls,
    renamedFrom: clean(redirectFromsFor(slug, redirects)).filter(
      (url) => !oldUrls.includes(url),
    ),
  }
}

/**
 * The real name of every folder in the published tree, keyed by the slug path
 * jotter will find it at.
 *
 * `fetch-content.mjs` writes each note **to its slug**, so
 * `Wisdom & Approaches/Critical Thinking.md` lands on disk as
 * `wisdom-approaches/critical-thinking.md`, and `src/lib/tree.ts` derives its
 * folders from the paths on disk. Note *titles* survive that because the
 * snapshot carries one and `applyNoteMetadata` writes it into the file; folders
 * have no file to write anything into, so the sidebar read `about`,
 * `wisdom-approaches`, `wp-statistics` where Obsidian Publish reads `About`,
 * `Wisdom & Approaches`, `WP Statistics`.
 *
 * The real names never left, though: the manifest is keyed by the original
 * vault path. So this zips each key's directory segments against its slug's,
 * and no plugin change is needed.
 *
 * **A pair whose segment counts differ is skipped**, which is the one case that
 * would otherwise be worse than doing nothing: a `permalink:` can move a note
 * out of its folder entirely, and zipping `Wisdom & Approaches/Critical
 * Thinking.md` against a slug of `essays/critical-thinking` would confidently
 * label `essays` as "Wisdom & Approaches".
 *
 * A folder whose name already *is* its slug segment is left out: it is not a
 * correction, and the map is written into a config file somebody reads.
 *
 * @param entries `Object.entries(snapshot.files)`
 * @returns {Record<string, string>} slug path -> display name
 */
export function folderNamesFor(entries) {
  /** @type {Record<string, string>} */
  const names = {}
  for (const [path, file] of entries) {
    if (typeof file?.slug !== 'string' || !path.toLowerCase().endsWith('.md')) continue

    const folders = path.split('/').slice(0, -1)
    const slugFolders = file.slug.split('/').slice(0, -1)
    if (folders.length !== slugFolders.length) continue

    for (let i = 0; i < slugFolders.length; i++) {
      const key = slugFolders.slice(0, i + 1).join('/')
      if (!key || names[key] !== undefined || slugFolders[i] === folders[i]) continue
      names[key] = folders[i]
    }
  }
  return names
}

/**
 * `snapshot.links`, re-keyed from vault path to the path the note is written at.
 *
 * This is not cosmetic. `src/lib/links-index.ts:42` keys every lookup on the
 * note's own on-disk path, and `resolve.ts:109` passes exactly that, which
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

/**
 * Every frontmatter key `src/lib/dates.ts` reads a date out of, mirrored here
 * because this script runs under plain Node before any bundler exists and that
 * module is TypeScript.
 *
 * `test/snapshot.test.ts` asserts the two lists are identical rather than
 * trusting this comment, the same way `ANALYTICS_PROVIDERS` is checked against
 * `src/lib/config.ts`. A spelling added there and missed here would be a note
 * whose own `date:` is silently overwritten by the filesystem's guess.
 */
export const FRONTMATTER_CREATED = ['created', 'date', 'created_at', 'createdAt', 'published']
export const FRONTMATTER_UPDATED = ['updated', 'modified', 'updated_at', 'updatedAt', 'lastmod']

/**
 * The dates to write into a note, from the file stats the snapshot carries.
 *
 * Why this exists at all: a vault fetched from a snapshot is written fresh to a
 * scratch directory, so every fallback `src/lib/dates.ts` has collapses at
 * once. There is no frontmatter date (the author wrote none), no git history
 * (the directory is `rm -rf`'d and rewritten on every build), and the mtime is
 * the instant `writeFile` ran. All three land on *now*, which is why every note
 * on a site built this way read "Created" as the day of the last deploy.
 *
 * **`ctime` is best effort and it is treated as such.** Obsidian takes it from
 * the filesystem, and sync, a restore from backup and an ordinary file transfer
 * all destroy it; a note's own `created:` is the only trustworthy source, which
 * is why `applyNoteMetadata` never overwrites one. The cheap guard against the
 * commonest corruption is here: a creation date *after* the last modification
 * is not a note edited before it existed, it is a copy operation's timestamp,
 * so `mtime` wins.
 *
 * A snapshot from a plugin that predates `ctime` has only `mtime`, and both
 * dates come from it: the same day, which is what
 * `src/components/Frontmatter.astro` renders as a single "Created" row. That is
 * the whole of what such a snapshot knows.
 *
 * @returns `{ created?, updated? }` as ISO strings, empty when the snapshot
 *   carries no usable stat at all.
 */
export function snapshotDates(file) {
  const stamp = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

  const mtime = stamp(file?.mtime)
  const ctime = stamp(file?.ctime)

  const created = ctime === undefined || (mtime !== undefined && ctime > mtime) ? mtime : ctime
  const updated = mtime ?? created
  if (created === undefined && updated === undefined) return {}

  return {
    ...(created === undefined ? {} : { created: new Date(created).toISOString() }),
    ...(updated === undefined ? {} : { updated: new Date(updated).toISOString() }),
  }
}

/** YAML double-quoted scalars accept JSON escaping. */
const quote = (value) => JSON.stringify(String(value))

const hasKey = (lines, key) => lines.some((line) => new RegExp(`^${key}\\s*:`).test(line))

/**
 * Carry the snapshot's resolved title, the note's own names and its old
 * addresses into its frontmatter.
 *
 * Files are written at their slug, so without the snapshot's title jotter would
 * name every page after its URL: "cafe-resume", and the homepage "index". The
 * plugin has already worked the real one out (frontmatter `title`, else the
 * first H1, else the filename), so it is copied rather than re-derived.
 *
 * **What the author wrote wins.** A note with its own `title:` is left alone.
 * `aliases` is the one key that is *merged* rather than skipped, and that is
 * not an exception to the rule: the snapshot's `aliases` are read out of this
 * note's own frontmatter by the plugin, so the merged list is a superset of
 * what the author typed, never a replacement for it.
 *
 * `oldUrls` and `renamedFrom` are jotter's own keys and hold no author content
 * at all, so they are written whole. A note that happens to carry one already
 * (a hand-written redirect, a previous build's output left in a vault) has it
 * replaced rather than appended to, because the snapshot is the authority on
 * which addresses this note used to answer at, and two spellings of the same
 * key in one YAML block is not a document either parser reads the same way.
 *
 * `permalink` is the one key this pass can *remove*, and only when the snapshot
 * disagrees with it. The plugin decides where a note is published and this
 * script writes the note **at that address**, so a `permalink:` naming a
 * different one is a stale instruction that the starter would otherwise obey:
 * `applyPermalinks` in `src/lib/vault.ts` honours the key character for
 * character and runs *before* anything can claim the site root. That is exactly
 * how a note set as the homepage lands back at its old URL with `/` falling
 * through to the generated index, silently, on a build where every layer did
 * what it was told. The value is not thrown away: it moves to `renamedFrom:`,
 * so the address the note used to be served at redirects to the new one.
 *
 * `created` and `updated` are the strictest of the four: written **only** when
 * the note declares no date of its own under any of the ten spellings
 * `src/lib/dates.ts` recognises. The snapshot's are filesystem timestamps and
 * the author's are not, so the author's win outright rather than merging. See
 * `snapshotDates`.
 *
 * The common case (no key present yet) is a line insertion, which touches
 * nothing else in the file. Only a key that already exists needs a parse.
 */
export function applyNoteMetadata(text, meta = {}, warnings = []) {
  const clean = (values) => [...new Set((values ?? []).map((v) => String(v)).filter(Boolean))]
  const aliases = clean(meta.aliases)
  /**
   * jotter's two address keys, in the order they are written, each present only
   * if it has something to say. One list rather than two locals because every
   * step below treats them identically: written whole, replaced not merged, and
   * printed in this order. What separates them is the status
   * `buildRedirectRules` gives each, and that is decided in `oldAddressesFor`.
   */
  const oldUrls = clean(meta.oldUrls)
  const renamedFrom = clean(meta.renamedFrom)
  /** The pair, as `[key, values]`, skipping whichever has nothing to say. */
  const addresses = () =>
    [
      ['oldUrls', oldUrls],
      ['renamedFrom', renamedFrom],
    ].filter(([, values]) => values.length > 0)
  const lines = text.split('\n')

  const list = (key, values) => `${key}: [${values.map(quote).join(', ')}]`

  /**
   * The dates, as frontmatter lines, given what the note already declares.
   * Quoted, so the value is a string under every YAML schema rather than a
   * timestamp under some of them; `asDate` in `src/lib/dates.ts` parses it back.
   */
  const dateLines = (block) => {
    const out = []
    const declares = (keys) => block !== null && keys.some((key) => hasKey(block, key))
    if (meta.created && !declares(FRONTMATTER_CREATED)) out.push(`created: ${quote(meta.created)}`)
    if (meta.updated && !declares(FRONTMATTER_UPDATED)) out.push(`updated: ${quote(meta.updated)}`)
    return out
  }

  if (lines[0]?.trim() !== '---') {
    const additions = []
    if (meta.title) additions.push(`title: ${quote(meta.title)}`)
    additions.push(...dateLines(null))
    if (aliases.length > 0) additions.push(list('aliases', aliases))
    for (const [key, values] of addresses()) additions.push(list(key, values))
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
  const mergingAliases = aliases.length > 0 && (hasKey(block, 'aliases') || hasKey(block, 'alias'))
  const replacingAddresses = addresses().some(([key]) => hasKey(block, key))
  /**
   * Only a parse can tell whether the declared `permalink:` is the address the
   * snapshot published or a different one, and only a parse can remove it, so a
   * note carrying the key at all takes the slow path when a slug was given.
   */
  const checkingPermalink = Boolean(meta.servedAt) && hasKey(block, 'permalink')

  if (!mergingAliases && !replacingAddresses && !checkingPermalink) {
    const additions = []
    if (meta.title && !hasKey(block, 'title')) additions.push(`title: ${quote(meta.title)}`)
    additions.push(...dateLines(block))
    if (aliases.length > 0) additions.push(list('aliases', aliases))
    for (const [key, values] of addresses()) additions.push(list(key, values))
    if (additions.length === 0) return text
    return [...lines.slice(0, close), ...additions, ...lines.slice(close)].join('\n')
  }

  const doc = parseDocument(block.join('\n'))
  if (doc.errors.length > 0) {
    // jotter's own scan survives malformed YAML (`src/lib/vault.ts:132`) and so
    // does this: the note keeps every name it had, and loses only what this
    // pass wanted to add. Said out loud, because a legacy URL that stopped
    // answering is not something to discover from a 404.
    warnings.push(
      `frontmatter could not be parsed (${doc.errors[0].message}), so its old addresses ` +
        `were not written`,
    )
    return text
  }

  if (aliases.length > 0) {
    const key = doc.has('aliases') || !doc.has('alias') ? 'aliases' : 'alias'
    const existing = doc.toJS()?.[key]
    const kept = (Array.isArray(existing) ? existing : existing == null ? [] : [existing])
      .map((value) => String(value))
      .filter(Boolean)
    doc.set(key, [...kept, ...aliases.filter((alias) => !kept.includes(alias))])
  }
  if (checkingPermalink) {
    const declared = doc.toJS()?.permalink
    const values = (Array.isArray(declared) ? declared : declared == null ? [] : [declared])
      .map((value) => stripSlashes(String(value)))
      .filter(Boolean)
    // The first value is the one that moves a note; the rest are already only
    // redirects, and they survive the same way this one does.
    if (values.length > 0 && values[0] !== meta.servedAt) {
      doc.delete('permalink')
      for (const value of values) {
        if (value === meta.servedAt || oldUrls.includes(value) || renamedFrom.includes(value)) continue
        renamedFrom.push(value)
      }
      warnings.push(
        `its permalink ("${values[0]}") is not where the plugin publishes it ` +
          `("${meta.servedAt}"), so the key was dropped and the old address now redirects`,
      )
    }
  }
  for (const [key, values] of addresses()) doc.set(key, values)
  if (meta.title && !doc.has('title')) doc.set('title', String(meta.title))
  if (meta.created && !FRONTMATTER_CREATED.some((key) => doc.has(key))) {
    doc.set('created', String(meta.created))
  }
  if (meta.updated && !FRONTMATTER_UPDATED.some((key) => doc.has(key))) {
    doc.set('updated', String(meta.updated))
  }

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
