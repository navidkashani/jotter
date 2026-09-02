/**
 * The RSS feed, as a string.
 *
 * Pure, and the direct sibling of `toNetlify()`, `toVercel()` and `robotsTxt()`
 * in `src/lib/redirects.ts`: config plus vault in, a string out, written by the
 * vault integration at `astro:build:done`. No DOM, no `node:fs`, no i18n:
 * vitest runs `environment: 'node'` and there is no jsdom, so everything with a
 * right answer lives where a unit test can reach it. That is also why the
 * channel title and description arrive as arguments rather than through
 * `src/i18n/index.ts`, which would drag `src/lib/site.ts` and `node:fs` in
 * behind them.
 *
 * `@astrojs/rss` was the obvious alternative and is the wrong shape here: it
 * wants a page endpoint, and a route cannot be *absent* the way an unwritten
 * file can. Forty lines of concatenation is not worth the only dependency in
 * the tree that `npm test` could not exercise directly.
 *
 * Measured against the RSS Advisory Board's Best Practices Profile, which is
 * also what the W3C Feed Validation Service checks. Quartz's own feed
 * (`quartz/plugins/emitters/contentIndex.tsx`) omits five things this restores:
 * `xmlns:atom` and `<atom:link rel="self">`, `<language>`, `<lastBuildDate>`,
 * an explicit `isPermaLink`, and a scheme that is not hardcoded to `https`.
 * The sixth difference is escaping rather than CDATA (see `escapeXml`).
 */
import { noteHref } from './href.js'
import type { VaultNote } from './vault.js'

/** Where the feed is written, and what every `rel="alternate"` points at. */
export const FEED_PATH = '/rss.xml'

/**
 * A hard cap, a constant, and deliberately not a config key.
 *
 * Quartz's default is 10. Ten is too few here for a reason that only shows up
 * with a *revision*: the window is ordered by `updated`, so editing a handful
 * of old notes pushes recent ones out of it, and because readers dedupe on
 * `<guid>`, an item evicted before a subscriber polled is one they will never
 * be shown. Silent loss, invisible to both sides. Fifty is wide enough that a
 * weekend of tidying cannot do that to a fortnightly subscriber, and still a
 * few KB at any vault size.
 *
 * A feed is a change notification, not an archive. `/notes` is the archive, and
 * it is one click from every item.
 */
export const MAX_ITEMS = 50

export interface FeedOptions {
  /** The *whole* vault. Filtering is this module's job (see `feedXml`). */
  notes: readonly VaultNote[]
  title: string
  description: string
  /** Validated absolute site URL. The schema guarantees it is present. */
  siteUrl: string
  locale: string
  author?: string
}

/**
 * Escaped, never CDATA.
 *
 * A CDATA section ends at the first `]]>`, so a note containing one terminates
 * it early and corrupts the document: Quartz's feed has exactly that hole.
 * Escaping has no such hole, which means it cannot be forgotten. Applied to
 * every interpolated value without exception, including URLs: they are already
 * percent-encoded by `noteHref`, and running them through here anyway is what
 * makes "every value is escaped" a property of the file rather than a claim
 * about each call site.
 */
const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

export function feedXml({
  notes,
  title,
  description,
  siteUrl,
  locale,
  author,
}: FeedOptions): string {
  const absolute = (path: string) => new URL(path, siteUrl).href

  /**
   * The filter is here rather than in the caller, and that is the whole reason
   * this function takes the entire vault.
   *
   * The feed is the one output whose note list is not the route list: every
   * page comes from `src/lib/site.ts`'s already-filtered `notes`, so a mistake
   * in *this* list is a mistake nothing else in the build would make too. It
   * belongs in one tested place, next to the thing that could leak, and the
   * test feeds it `test/fixtures/vault/private/`, then asserts that title
   * appears nowhere in the output.
   */
  const items = notes
    .filter((note) => note.published)
    /**
     * By `updated`, which agrees with `byUpdated` in `src/lib/site.ts` and so
     * with `/notes` and every listing. The item's *publication* date is a
     * separate question, answered below.
     */
    .sort((a, b) => b.dates.updated.getTime() - a.dates.updated.getTime())
    .slice(0, MAX_ITEMS)

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"',
    '     xmlns:atom="http://www.w3.org/2005/Atom"',
    '     xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '  <channel>',
    `    <title>${escapeXml(title)}</title>`,
    `    <link>${escapeXml(absolute('/'))}</link>`,
    /**
     * The profile requires this and the W3C validator warns without it: a feed
     * that does not name its own address cannot be re-found once it has been
     * copied somewhere. Quartz omits it, and omits the namespace it needs.
     */
    `    <atom:link href="${escapeXml(absolute(FEED_PATH))}" rel="self" type="application/rss+xml"/>`,
    /**
     * An empty `<description>` is invalid (it is one of the three required
     * channel children), so a site that never set one falls back to its title
     * rather than emitting a hole.
     */
    `    <description>${escapeXml(description || title)}</description>`,
    `    <language>${escapeXml(locale)}</language>`,
  ]

  /**
   * The newest item's `updated`, never `new Date()`. Two builds of an unchanged
   * vault produce byte-identical output, which is what lets a deploy diff mean
   * something. Omitted entirely for an empty vault: there is no last build to
   * report, and the element is optional.
   */
  if (items.length > 0) {
    lines.push(`    <lastBuildDate>${items[0].dates.updated.toUTCString()}</lastBuildDate>`)
  }
  lines.push('    <generator>jotter</generator>')

  for (const note of items) {
    /**
     * Every URL comes from `noteHref()`, so the feed cannot disagree with the
     * site about where a note lives: it does not compute an answer of its own,
     * and there is no exception. The note claiming `/` reaches here with the
     * slug `index`, which `noteHref` has always spelled `/`; the feed used to
     * take a `homepageSlug` to step around that, and stepping around it was the
     * bug. A dead link is worse in a feed than on a page, where a reader at
     * least has navigation to recover through.
     */
    const url = absolute(noteHref(note.slug))

    lines.push('    <item>')
    lines.push(`      <title>${escapeXml(note.title)}</title>`)
    lines.push(`      <link>${escapeXml(url)}</link>`)
    /**
     * `isPermaLink` defaults to `true`, so Quartz omitting it is not wrong,
     * but the profile names forgetting it as a common mistake, and a feed that
     * says so survives a reader that guesses.
     */
    lines.push(`      <guid isPermaLink="true">${escapeXml(url)}</guid>`)
    /**
     * The excerpt the vault scan already computed for note cards and hover
     * previews, not the rendered note. Full HTML would mean rewriting every
     * wikilink, image and transclusion to an absolute URL (the layer
     * open-publish's `rewrite.mjs` exists to be), and would force the feed to
     * become a route with access to the render pipeline. Quartz's default
     * (`rssFullHtml: false`) agrees.
     *
     * Omitted, never emitted empty: RSS requires a title *or* a description,
     * and the title is always there.
     */
    if (note.excerpt) lines.push(`      <description>${escapeXml(note.excerpt)}</description>`)
    /**
     * `dc:creator`, not `<author>`. RSS's `<author>` requires an e-mail
     * address and `config.author` is a name; the profile is explicit that the
     * same item should not carry both.
     */
    if (author) lines.push(`      <dc:creator>${escapeXml(author)}</dc:creator>`)
    /**
     * One per tag, as written. The profile recommends a slash-delimited string
     * naming a position in a taxonomy, which is exactly jotter's nested tag
     * format, so this is free, and it makes reader-side filtering work.
     */
    for (const tag of note.tags) lines.push(`      <category>${escapeXml(tag)}</category>`)
    /**
     * Two date formats in one item, and they are not interchangeable. Putting
     * either in the other's element is the easy mistake here.
     *
     * `<pubDate>` is RFC-822 (`toUTCString`), one of the three formats the
     * profile reports as tested across all eighteen aggregators. It is the
     * *created* date and it does not move when a typo is fixed: readers sort by
     * it, so a moving one reshuffles their list for nothing, and since a
     * stable guid means a revised item never resurfaces anyway, moving it buys
     * nothing either.
     *
     * `<atom:updated>` is Atom, so RFC-3339 (`toISOString`). It is the element
     * that actually means "revised", in a namespace already declared above for
     * `rel="self"`.
     */
    lines.push(`      <pubDate>${note.dates.created.toUTCString()}</pubDate>`)
    lines.push(`      <atom:updated>${note.dates.updated.toISOString()}</atom:updated>`)
    lines.push('    </item>')
  }

  lines.push('  </channel>', '</rss>', '')
  return lines.join('\n')
}
