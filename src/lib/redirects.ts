/**
 * Redirects, generated from `aliases:` frontmatter plus whatever the config
 * adds.
 *
 * An alias is a promise that a name still works. Obsidian honours it inside the
 * vault; on the web it has to become a real redirect or the promise is only
 * kept for people who never left the app.
 *
 * Pure, so `astro.config.ts` (which emits the host files) and `src/lib/site.ts`
 * (which is bundled) compute the same set without importing each other.
 */
import { noteHref } from './href.js'
import { slugifySegment } from './slug.js'
import type { VaultNote } from './vault.js'

export interface RedirectSources {
  notes: readonly VaultNote[]
  /** Slugs already owned by a page: a redirect must never shadow one. */
  taken: Iterable<string>
  extra?: Record<string, string>
}

/** `from` path -> `to` path, both site-absolute and leading-slashed. */
export function buildRedirects({ notes, taken, extra = {} }: RedirectSources): Record<string, string> {
  const owned = new Set(taken)
  const out: Record<string, string> = {}

  for (const note of notes) {
    for (const alias of note.aliases) {
      const from = slugifySegment(alias)
      // Skip an alias that is empty, that a real page already owns, that
      // another note claimed first, or that points at its own note.
      if (!from || owned.has(from) || out[`/${from}`]) continue
      const to = noteHref(note.slug)
      if (to === `/${from}`) continue
      out[`/${from}`] = to
    }
  }

  // Explicit config wins over a generated one: it is the escape hatch.
  for (const [from, to] of Object.entries(extra)) {
    out[from.startsWith('/') ? from : `/${from}`] = to.startsWith('/') ? to : `/${to}`
  }

  return out
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
 * Those files are index chunks and a WebAssembly module — machine-readable
 * fragments of pages a crawler can already read whole, at their own URLs. A
 * crawler has nothing to gain there and jotter has a budget to lose. The rule
 * is unconditional because a `robots.txt` that flips with a feature flag is a
 * `robots.txt` someone has to remember to check.
 */
export const robotsTxt = (noIndex: boolean, sitemapUrl?: string): string =>
  noIndex
    ? 'User-agent: *\nDisallow: /\n'
    : `User-agent: *\nAllow: /\nDisallow: /pagefind/\n${sitemapUrl ? `\nSitemap: ${sitemapUrl}\n` : ''}`
