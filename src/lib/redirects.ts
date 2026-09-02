/**
 * Redirects, generated from vacated slugs and `aliases:` frontmatter plus
 * whatever the config adds.
 *
 * An alias is a promise that a name still works. Obsidian honours it inside the
 * vault; on the web it has to become a real redirect or the promise is only
 * kept for people who never left the app.
 *
 * Pure, so `astro.config.ts` (which emits the host files) and `src/lib/site.ts`
 * (which is bundled) compute the same set without importing each other.
 *
 * ## Slug space in, URL space out
 *
 * The map is built entirely in **slug** space, so `owned.has(from)`, the
 * first-write rule and the `taken` list from `astro.config.ts` all keep
 * comparing like with like, and encoded **once** at the end. Sources used to be
 * raw slugs while destinations came from `noteHref()`, which was already wrong
 * for any non-ASCII alias, and Netlify's own documentation requires paths in
 * `_redirects` to be URL-encoded.
 */
import { noteHref } from './href.js'
import { slugFor, slugifySegment, type SlugStyle } from './slug.js'
import { encodeSlug } from './url.js'
import type { VaultNote } from './vault.js'

export interface RedirectSources {
  notes: readonly VaultNote[]
  /** Slugs already owned by a page: a redirect must never shadow one. */
  taken: Iterable<string>
  extra?: Record<string, string>
  /** The style the notes' slugs were assigned under. See `src/lib/slug.ts`. */
  slugs?: SlugStyle
}

/**
 * A name, as a redirect source.
 *
 * `derive` slugifies it, because that is what the derived slug it is standing
 * in for would have been. The other two carry it verbatim: under `preserve` and
 * `obsidian` the whole contract is that jotter does not invent spellings, and
 * an alias is a name the author typed. Slashes are trimmed and empty segments
 * dropped either way: a leading one would make `//host`, which is not a path
 * on this site at all.
 */
const sourceFor = (name: string, style: SlugStyle): string =>
  style === 'derive'
    ? slugifySegment(name)
    : name.normalize('NFC').split('/').filter(Boolean).join('/')

/** `from` path -> `to` path, both site-absolute, leading-slashed and encoded. */
export function buildRedirects({
  notes,
  taken,
  extra = {},
  slugs: style = 'derive',
}: RedirectSources): Record<string, string> {
  const owned = new Set(taken)
  /** slug -> slug, first write wins. */
  const out = new Map<string, string>()

  const claim = (from: string, to: string): void => {
    // Skip a source that is empty, that is already where it points, that a real
    // page owns, or that something claimed first. `index` is never a source:
    // `/` is a real page in every build (the note claiming it, or the
    // generated landing page), and `/index` is not a URL this site serves.
    if (!from || from === 'index' || from === to || owned.has(from) || out.has(from)) return
    out.set(from, to)
  }

  /**
   * Every note whose slug is not the one its path derives 301s from the derived
   * one, because that is the URL it was published at until something moved it.
   *
   * One rule rather than the homepage-shaped special case this replaces, and it
   * covers all three ways a note moves: promotion to `/`, a `permalink:`, and a
   * change of `slugs:` style. Recomputed from the path rather than remembered
   * on the note: `slugFor` is pure, and a `previousSlug` field would be one
   * more thing to keep in step.
   *
   * A collision suffix is *not* covered, and correctly so: there the derived
   * slug is owned by the note that won it, and `owned.has(from)` skips it.
   *
   * Before the aliases, so a URL that actually served this note outranks a name
   * that only ever pointed at another one, and an alias that was unreachable
   * while the page existed does not become live by inheriting its vacated URL.
   */
  for (const note of notes) {
    claim(slugFor(note.path, style), note.slug)
  }

  /**
   * The second and later values of a `permalink:` list: old addresses the note
   * answers at without being served from. Ahead of the aliases for the same
   * reason the vacated slugs are: these are URLs somebody published.
   */
  for (const note of notes) {
    for (const permalink of note.permalinks.slice(1)) claim(permalink, note.slug)
  }

  for (const note of notes) {
    for (const alias of note.aliases) claim(sourceFor(alias, style), note.slug)
  }

  const redirects: Record<string, string> = {}
  for (const [from, to] of out) redirects[`/${encodeSlug(from)}`] = noteHref(to)

  // Explicit config wins over a generated one: it is the escape hatch, it is
  // written in URL space by hand, and it is merged verbatim.
  for (const [from, to] of Object.entries(extra)) {
    redirects[from.startsWith('/') ? from : `/${from}`] = to.startsWith('/') ? to : `/${to}`
  }

  return redirects
}

/** Netlify and Cloudflare Pages. */
export const toNetlify = (redirects: Record<string, string>): string =>
  Object.entries(redirects)
    .map(([from, to]) => `${from} ${to} 301`)
    .join('\n') + '\n'

/** Vercel. `cleanUrls` matches `trailingSlash: 'never'`. */
export const toVercel = (redirects: Record<string, string>): string =>
  JSON.stringify(
    {
      cleanUrls: true,
      trailingSlash: false,
      redirects: Object.entries(redirects).map(([source, destination]) => ({
        source,
        destination,
        permanent: true,
      })),
    },
    null,
    2,
  ) + '\n'

/**
 * A site that asked not to be indexed should say so where crawlers look.
 *
 * `/pagefind/` is disallowed unconditionally, whether or not search is built.
 * Those files are index chunks and a WebAssembly module: machine-readable
 * fragments of pages a crawler can already read whole, at their own URLs. A
 * crawler has nothing to gain there and jotter has a budget to lose. The rule
 * is unconditional because a `robots.txt` that flips with a feature flag is a
 * `robots.txt` someone has to remember to check.
 */
export const robotsTxt = (noIndex: boolean, sitemapUrl?: string): string =>
  noIndex
    ? 'User-agent: *\nDisallow: /\n'
    : `User-agent: *\nAllow: /\nDisallow: /pagefind/\n${sitemapUrl ? `\nSitemap: ${sitemapUrl}\n` : ''}`
