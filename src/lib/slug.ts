/**
 * Path → URL slug. Obsidian filenames are human text: spaces, emoji, Cyrillic,
 * ampersands. The slug must be a legal URL, stable across builds, and readable.
 *
 * Non-ASCII letters are *kept*, not transliterated away — a Cyrillic vault
 * should not slug every note to `note-1`, `note-2`. Browsers percent-encode
 * them on the wire and display them decoded.
 *
 * There are three site-wide rules, chosen with `slugs:` in `jotter.config.ts`,
 * and they differ only in how much of the vault path survives. `derive` is the
 * default and slugifies; the other two carry the path to the URL untouched, for
 * a site moving onto a domain whose old addresses are already in other people's
 * bookmarks, links and search rankings. See `docs/url-styles.md`.
 *
 * A slug is not a URL — see `src/lib/url.ts` for the encoder that separates
 * them, and why. Everything in this file speaks slugs.
 */

/**
 * How a vault path becomes a slug.
 *
 * - `derive` — slugify: lowercase, dashes, ASCII-safe punctuation dropped.
 * - `preserve` — the path verbatim.
 * - `obsidian` — the path verbatim with space → `+`, which is the address
 *   Obsidian Publish served the same file at.
 */
export type SlugStyle = 'derive' | 'preserve' | 'obsidian'

/** Slugify one path segment. */
export function slugifySegment(segment: string): string {
  const slug = segment
    .normalize('NFC')
    .replace(/\.md$/i, '')
    .trim()
    .toLowerCase()
    // Separators people actually type between words.
    .replace(/[\s_]+/g, '-')
    // Drop anything that is not a letter, number, dash or dot.
    .replace(/[^\p{L}\p{N}.-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return slug
}

/**
 * Vault-relative path → slug. `Notes/My Note.md` → `notes/my-note`.
 * A file named `index.md` claims its folder: `Notes/index.md` → `notes`.
 */
export function slugifyPath(path: string): string {
  const segments = path.split('/').filter(Boolean).map(slugifySegment).filter(Boolean)
  if (segments.length === 0) return 'untitled'
  if (segments.length > 1 && segments[segments.length - 1] === 'index') segments.pop()
  return segments.join('/')
}

/**
 * The vault path, verbatim: NFC, minus `.md`.
 *
 * **NFC on the slug, never on the path.** Astro NFC-normalises every route
 * param itself (`sanitizeParams`, `core/routing/generator.js`), so a slug left
 * decomposed would be *routed* at its composed path while every `Map` key, href
 * and redirect stayed decomposed — every link to that note 404s. The path must
 * stay byte-exact in the other direction, because `readFileSync` and the
 * collection's `generateId: ({ entry }) => entry` both depend on it. This is
 * live on exactly the vaults these styles are for: macOS Finder writes NFD, zsh
 * writes NFC, APFS preserves whichever it was given, Linux preserves raw bytes.
 */
export function preservePath(path: string): string {
  return path.normalize('NFC').replace(/\.md$/i, '')
}

/**
 * The same, with space → `+`: what Obsidian Publish's form-urlencoding leaves
 * once the URL is percent-decoded, which is what a slug is.
 *
 * Deliberately byte-identical to `obsidianPublishUrl()` in open-publish's
 * `plugin/src/core/slug.ts` — the third function the two projects agree on
 * character for character, beside `protectedRanges()` and `anchorFor()`. That
 * parity is what lets a vault published by the plugin and a vault built by
 * jotter answer at the same addresses, and `test/lib.test.ts` asserts it rather
 * than trusting this comment. (The NFC pass above is jotter's own, for Astro's
 * router; on any already-composed path the two are the same string.)
 */
export function obsidianPath(path: string): string {
  return preservePath(path)
    .split('/')
    .map((segment) => segment.replace(/ /g, '+'))
    .join('/')
}

/**
 * Path → slug, under the configured style. The one entry point the rest of the
 * build calls.
 *
 * Two rules survive every style, because they are about *routing* rather than
 * naming: `.md` is dropped, and a trailing `index` segment claims its folder
 * (`Notes/index.md` → `Notes`, and a root `index.md` → `index`, which
 * `noteHref` has always spelled `/`).
 */
export function slugFor(path: string, style: SlugStyle = 'derive'): string {
  if (style === 'derive') return slugifyPath(path)

  const base = style === 'obsidian' ? obsidianPath(path) : preservePath(path)
  const segments = base.split('/').filter(Boolean)
  if (segments.length === 0) return 'untitled'
  if (segments.length > 1 && segments[segments.length - 1] === 'index') segments.pop()
  return segments.join('/')
}

/**
 * Resolve slug collisions deterministically. Two different files can slugify to
 * the same string (`Note.md` and `note.md`, or `A&B` and `A B`). Sorting first
 * means the winner does not depend on filesystem enumeration order, so a build
 * on Linux and a build on macOS produce the same URLs.
 *
 * Returns a path → slug map, and the collisions it had to break, for warning.
 */
export function assignSlugs(
  paths: readonly string[],
  style: SlugStyle = 'derive',
): {
  slugs: Map<string, string>
  collisions: { slug: string; paths: string[] }[]
} {
  const claimed = new Map<string, string>() // slug -> winning path
  const slugs = new Map<string, string>()
  const grouped = new Map<string, string[]>()

  for (const path of [...paths].sort()) {
    const base = slugFor(path, style)
    let slug = base
    let n = 2
    while (claimed.has(slug)) slug = `${base}-${n++}`
    claimed.set(slug, path)
    slugs.set(path, slug)
    grouped.set(base, [...(grouped.get(base) ?? []), path])
  }

  const collisions = [...grouped.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([slug, group]) => ({ slug, paths: group }))

  return { slugs, collisions }
}

/** Illegal in a Windows filename, and so unwritable into `dist/` on a Windows box. */
const WINDOWS_ILLEGAL = /[<>:"|?*\\]/

/**
 * A slug that would be written outside `dist/`. Mirrors `escapesContentDir` in
 * the Open Publish starter's `scripts/fetch-content.mjs`, and for the same
 * reason: the generator is holding the pen, so it checks rather than assumes.
 */
const escapesOutputDir = (slug: string): boolean =>
  slug.startsWith('/') || slug.split('/').some((segment) => segment === '.' || segment === '..')

/**
 * Everything about a set of slugs that a person needs to be told, once, at the
 * scan — reported without renaming anything.
 *
 * Renaming would be jotter inventing a slug it was explicitly told to carry
 * verbatim, and the whole point of `preserve`, `obsidian` and `permalink:` is
 * that it does not. But silence is not the alternative: two of these are
 * failures that happen on a *different machine* than the one the author is
 * sitting at, which is the worst way to find out.
 *
 * - **Case-only collisions.** `Note.md` beside `note.md` are two files on Linux
 *   and one on macOS or Windows, so the build filesystem silently overwrites
 *   one before any host sees it. `derive` cannot hit this — it lowercases, so
 *   the two collide earlier, in `assignSlugs`, and are suffixed and reported
 *   there.
 * - **Windows-illegal characters.** Legal on macOS and Linux, un-writable into
 *   `dist/` on a Windows build box.
 *
 * Both warnings are about **published** notes only, the same rule the image and
 * direction checks in `src/lib/vault.ts` follow: an excluded note has no page,
 * so nothing of it is ever written into `dist/` and neither hazard can bite.
 * The `throw` is not filtered, because a slug that escapes the output directory
 * is a mistake worth stopping for wherever it is written — and there is no
 * version of continuing that is better than stopping.
 */
export function slugHazards(
  notes: Iterable<{ path: string; slug: string; published?: boolean }>,
): string[] {
  const warnings: string[] = []
  const byLowercase = new Map<string, { path: string; slug: string }[]>()

  for (const note of notes) {
    if (escapesOutputDir(note.slug)) {
      throw new Error(
        `[jotter] "${note.path}" resolves to the slug "${note.slug}", which would be written ` +
          `outside dist/. A slug may not start with "/" or contain a "." or ".." segment. ` +
          `Fix the \`permalink:\` on that note, or move the file.`,
      )
    }

    // `published` is optional so a caller holding plain slugs — a test, a
    // future one — gets the checks rather than silence.
    if (note.published === false) continue

    const illegal = note.slug.match(WINDOWS_ILLEGAL)
    if (illegal) {
      warnings.push(
        `"${note.path}" is served at "/${note.slug}", which contains ${illegal[0]} — a ` +
          `character Windows refuses in a filename. This builds on macOS and Linux and fails ` +
          `on a Windows build machine. Rename the file, or set a \`permalink:\` without it.`,
      )
    }

    const key = note.slug.toLowerCase()
    byLowercase.set(key, [...(byLowercase.get(key) ?? []), note])
  }

  for (const group of byLowercase.values()) {
    if (group.length < 2) continue
    warnings.push(
      `Slugs differing only in case: ${group.map((n) => `"/${n.slug}" (${n.path})`).join(', ')}. ` +
        `These are separate pages on Linux and the same file on macOS and Windows, so one ` +
        `silently overwrites the other depending on where the site is built. Rename one.`,
    )
  }

  return warnings
}

/**
 * A `permalink:` value, or several, as slugs.
 *
 * Verbatim in every style — no slugification, no lowercasing, no substitutions
 * — because a permalink is an address somebody already published, and the one
 * thing it must not do is change. NFC for Astro's router (see `preservePath`),
 * and leading and trailing slashes are stripped so `/company/about` and
 * `company/about` mean the same thing, which is what Hugo does with `url:` and
 * what anyone typing one expects.
 */
export function normalizePermalinks(value: unknown): string[] {
  if (value == null) return []
  const list = Array.isArray(value) ? value : [value]
  return [
    ...new Set(
      list
        .map((entry) => String(entry).trim().normalize('NFC').replace(/^\/+|\/+$/g, ''))
        .filter(Boolean),
    ),
  ]
}

/** Heading text → anchor id, matching github-slugger (what Astro emits). */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}
