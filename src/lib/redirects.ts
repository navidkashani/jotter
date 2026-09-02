/**
 * Redirects, generated from vacated slugs, `permalink:`, `oldUrls:`,
 * `renamedFrom:` and `aliases:` frontmatter, plus whatever the config adds.
 *
 * An alias is a promise that a name still works. Obsidian honours it inside the
 * vault; on the web it has to become a real redirect or the promise is only
 * kept for people who never left the app. An old URL is a stronger promise
 * still: somebody else published it.
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
 *
 * ## 301 or 302
 *
 * Every rule carries the status it should be served with, and which one it gets
 * follows a single rule stated on `RedirectRule`: permanent only for an address
 * that came from a frozen record. Read that comment before changing a `true`
 * here to a `false` or back.
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
 * Where a redirect goes, and whether jotter is willing to promise it for ever.
 *
 * **`permanent` only for an address that came from a frozen record. Everything
 * this module recomputes from current frontmatter is temporary.** A `301` is
 * not a routing preference, it is a promise: a browser that has seen one stops
 * asking, indefinitely, and no `Cache-Control` bounds a redirect this build
 * writes.
 *
 * That is a promise the next build can retract, because every loop below
 * derives its rules from today's `notes` and remembers nothing about what the
 * last build published. One pair of them can even reverse. A note with a
 * `permalink: p` emits `d -> p` from the vacated-slug rule; delete the
 * permalink and the note is served at `d` again, the plugin records the move,
 * and it arrives here as `p -> d`. Both `301`, a browser holding the first and
 * being handed the second bounces between them until it gives up with
 * `ERR_TOO_MANY_REDIRECTS`, and it recovers only when its cache is cleared.
 * `resolveChain` in the plugin collapses chains *within* one snapshot and can
 * do nothing here: the stale half of this loop lives in somebody's browser.
 *
 * So the frozen sources stay permanent — `oldUrls:`, which is what
 * publish.obsidian.md served and nothing can retract, and the `redirects` an
 * author hand-wrote into the config — and the derived ones soften. **This
 * keeps the SEO that matters**: a migrated site's search equity is in its old
 * Obsidian Publish addresses, and those are exactly the ones still answering
 * `301`. For a rule the next build might withdraw, `302` was always the honest
 * answer.
 */
export interface RedirectRule {
  to: string
  /** `301` where true, `302` where not. */
  permanent: boolean
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

/**
 * `from` path -> where it goes and how firmly it is promised. Both paths are
 * site-absolute, leading-slashed and encoded.
 */
export function buildRedirectRules({
  notes,
  taken,
  extra = {},
  slugs: style = 'derive',
}: RedirectSources): Record<string, RedirectRule> {
  const owned = new Set(taken)
  /** slug -> rule, first write wins. */
  const out = new Map<string, RedirectRule>()

  const claim = (from: string, to: string, permanent: boolean): void => {
    // Skip a source that is empty, that is already where it points, that a real
    // page owns, or that something claimed first. `index` is never a source:
    // `/` is a real page in every build (the note claiming it, or the
    // generated landing page), and `/index` is not a URL this site serves.
    if (!from || from === 'index' || from === to || owned.has(from) || out.has(from)) return
    out.set(from, { to, permanent })
  }

  /**
   * Every note whose slug is not the one its path derives redirects from the
   * derived one, because that is the URL it was published at until something
   * moved it.
   *
   * One rule rather than the homepage-shaped special case this replaces, and it
   * covers all three ways a note moves: promotion to `/`, a `permalink:`, and a
   * change of `slugs:` style. Recomputed from the path rather than remembered
   * on the note: `slugFor` is pure, and a `previousSlug` field would be one
   * more thing to keep in step.
   *
   * **Temporary, and this is the rule that made it a rule.** Recomputed means
   * retractable: changing a `permalink:` or the homepage moves the note back,
   * and the move the plugin then records points the other way. See
   * `RedirectRule`.
   *
   * A collision suffix is *not* covered, and correctly so: there the derived
   * slug is owned by the note that won it, and `owned.has(from)` skips it.
   *
   * Before the aliases, so a URL that actually served this note outranks a name
   * that only ever pointed at another one, and an alias that was unreachable
   * while the page existed does not become live by inheriting its vacated URL.
   */
  for (const note of notes) {
    claim(slugFor(note.path, style), note.slug, false)
  }

  /**
   * The second and later values of a `permalink:` list: old addresses the note
   * answers at without being served from. Ahead of the aliases for the same
   * reason the vacated slugs are: these are URLs somebody published.
   *
   * Temporary all the same. The author owns this list and can reorder it or
   * drop an entry, and the next build would simply stop emitting the rule.
   */
  for (const note of notes) {
    for (const permalink of note.permalinks.slice(1)) claim(permalink, note.slug, false)
  }

  /**
   * `oldUrls:`, which is the same rule again and the reason it is a rule.
   *
   * These are the addresses publish.obsidian.md served this note at, written by
   * `scripts/fetch-content.mjs` from the snapshot's `legacyUrls`. Nothing
   * renders them.
   *
   * **The one permanent generated rule**, because it is the one whose source is
   * a frozen record. Obsidian Publish's addresses are what they were: no
   * frontmatter edit and no later build turns one back into a URL this site
   * serves. It is also the rule carrying a migrated site's whole search
   * history, which is why softening the rest costs nothing worth keeping.
   *
   * Before the aliases, because the paragraph above the vacated slugs already
   * argues the general case: a URL somebody published outranks a name that only
   * ever pointed at a note. This is that rule said out loud for the one key
   * whose whole content is published URLs.
   */
  for (const note of notes) {
    for (const url of note.oldUrls) claim(sourceFor(url, style), note.slug, true)
  }

  /**
   * `renamedFrom:`: the slugs this note has been served at on *this* site,
   * recorded by the plugin as it saw each rename.
   *
   * A published URL, like the key above. A key of its own because it is not
   * frozen: renaming the note back, or undoing whatever moved it, makes the
   * plugin record the opposite move and this rule reverse. That is the loop
   * `RedirectRule` describes, and a `302` is what keeps a browser asking.
   *
   * After `oldUrls:`, so an address that is both keeps the stronger promise.
   */
  for (const note of notes) {
    for (const url of note.renamedFrom) claim(sourceFor(url, style), note.slug, false)
  }

  /** An alias is a name, and the author can delete one. Temporary. */
  for (const note of notes) {
    for (const alias of note.aliases) claim(sourceFor(alias, style), note.slug, false)
  }

  const redirects: Record<string, RedirectRule> = {}
  for (const [from, rule] of out) {
    redirects[`/${encodeSlug(from)}`] = { to: noteHref(rule.to), permanent: rule.permanent }
  }

  // Explicit config wins over a generated one: it is the escape hatch, it is
  // written in URL space by hand, and it is merged verbatim. Permanent, and the
  // only source outside `oldUrls:` that is: an author who typed a redirect into
  // `jotter.config.ts` meant it, and the only thing that retracts it is that
  // same author editing that same line.
  for (const [from, to] of Object.entries(extra)) {
    redirects[from.startsWith('/') ? from : `/${from}`] = {
      to: to.startsWith('/') ? to : `/${to}`,
      permanent: true,
    }
  }

  return redirects
}

/**
 * The same map with the statuses dropped: `from` -> `to`.
 *
 * The shape this module returned before the statuses had to differ, kept
 * because a caller that only wants to know *where* an address goes should not
 * have to reach past a status it has no use for. `toNetlify` and `toVercel`,
 * which write the status down, take the rules.
 */
export const buildRedirects = (sources: RedirectSources): Record<string, string> =>
  Object.fromEntries(
    Object.entries(buildRedirectRules(sources)).map(([from, { to }]) => [from, to]),
  )

/** Netlify and Cloudflare Pages. */
export const toNetlify = (rules: Record<string, RedirectRule>): string =>
  Object.entries(rules)
    .map(([from, { to, permanent }]) => `${from} ${to} ${permanent ? 301 : 302}`)
    .join('\n') + '\n'

/** Vercel. `cleanUrls` matches `trailingSlash: 'never'`. */
export const toVercel = (rules: Record<string, RedirectRule>): string =>
  JSON.stringify(
    {
      cleanUrls: true,
      trailingSlash: false,
      redirects: Object.entries(rules).map(([source, { to, permanent }]) => ({
        source,
        destination: to,
        permanent,
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
