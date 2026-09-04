/**
 * The typed config a forker owns.
 *
 * Zod comes from `astro/zod` rather than a `zod` dependency of our own: Astro
 * re-exports it, and using the same instance guarantees API parity with content
 * collections. Installing `zod` separately is how you end up with two Zod
 * majors in one build.
 *
 * Every field has a default. `jotter.config.ts` may be `defineConfig({})` and
 * the site still builds.
 */
import { z } from 'astro/zod'

/**
 * Exported so a test can assert that every member has a tag in
 * `src/lib/analytics.ts`. Adding a provider here without a mapping there would
 * otherwise be a silent `undefined`: a configured site emitting nothing.
 */
export const analyticsProviders = [
  'none',
  'plausible',
  'umami',
  'goatcounter',
  'fathom',
  'cloudflare',
  'google',
] as const

/**
 * The three with a self-hosted mode. `host` on any of the other four is not a
 * preference jotter declines to honour, it is a misunderstanding (Fathom,
 * Cloudflare and Google have no self-hosted endpoint to point at), so it is
 * rejected below rather than ignored.
 */
const selfHostable: readonly string[] = ['plausible', 'umami', 'goatcounter']

export const jotterConfigSchema = z
  .object({
    /** Shown in the header and as the `<title>` suffix. */
    title: z.string().default('Slipbox'),
    description: z.string().default(''),
    /** Absolute site URL. Required for sitemap, RSS and canonical links. */
    url: z.url().optional(),
    author: z.string().default(''),

    /**
     * The card image for every page that does not name its own.
     *
     * A vault path (`attachments/og.png`), a `/`-rooted path for a file in
     * `public/`, or an absolute URL. Requires `url` (see the root refine).
     */
    image: z.string().optional(),

    /** BCP-47 tag, e.g. `en`, `de`, `ar`. Sets `<html lang>`. */
    locale: z.string().default('en'),
    dir: z.enum(['ltr', 'rtl']).default('ltr'),

    /** Vault location, relative to the project root. */
    vault: z.string().default('src/content/notes'),

    /** Reading layout. There is deliberately no reader-facing toggle. */
    layout: z.enum(['column', 'panels']).default('column'),
    /** Sidebar mode. Both templates ship. */
    nav: z.enum(['tree', 'tags', 'none']).default('tree'),

    /**
     * Obsidian's default is shortest-path. Quartz defaults to `absolute`, which
     * is why links that work in the app break on a Quartz site.
     */
    linkResolution: z.enum(['shortest', 'absolute', 'relative']).default('shortest'),

    /** `all` publishes unless a note opts out; `opt-in` requires `publish: true`. */
    publishGate: z.enum(['all', 'opt-in']).default('all'),

    /** Slug of the note that should claim `/`. Falls back to a generated landing page. */
    homepage: z.string().optional(),

    /**
     * How a vault path becomes a URL.
     *
     * `derive` slugifies (lowercase, dashes, punctuation dropped), and is what
     * every jotter site has always done. `preserve` and `obsidian` carry the
     * vault path to the URL untouched, and `obsidian` reproduces Obsidian
     * Publish's own addresses (space → `+`), so a site moving onto the domain
     * those URLs were served from keeps every inbound link and every search
     * ranking it had. A single note overrides all three with `permalink:` in
     * its frontmatter. See `docs/url-styles.md`.
     */
    slugs: z.enum(['derive', 'preserve', 'obsidian']).default('derive'),

    /** Obsidian's own default is `false`: a single newline becomes a line break. */
    strictLineBreaks: z.boolean().default(false),

    images: z.enum(['optimize', 'passthrough']).default('optimize'),

    /** Emitted into robots.txt and headers, and suppresses the sitemap. */
    noIndex: z.boolean().default(false),

    /**
     * Each feature that is off ships *no JavaScript at all*, because the island
     * is not rendered rather than hidden. A build assertion verifies it.
     */
    features: z
      .object({
        toc: z.boolean().default(true),
        backlinks: z.boolean().default(true),
        tags: z.boolean().default(true),
        themeToggle: z.boolean().default(true),
        /**
         * The block under a note's title: its dates, and the frontmatter fields
         * `src/lib/frontmatter.ts` declares as displayable.
         *
         * **Off by default**, which is what Obsidian Publish does: it shows
         * none of this. A garden and a changelog want opposite answers here, so
         * it is a switch rather than a decision, and the switch is reachable
         * from Obsidian as the `showPageMetadata` site option.
         *
         * On, the date rows still appear only where the date is a real one.
         * See `NoteDates.known`.
         */
        metadata: z.boolean().default(false),
        /**
         * Links to the notes either side of this one, at the foot of the page.
         * Neighbours are a note's siblings under the same folder, in the order
         * the sidebar already uses. `showPrevNext` in Obsidian.
         */
        prevNext: z.boolean().default(true),
        /**
         * The note's own title, printed as the `<h1>` above its content.
         *
         * On by default: Obsidian Publish's default, and what jotter rendered
         * unconditionally before this switch existed. Off suits a vault whose
         * notes open with a heading of their own, which would otherwise print
         * the title twice. `showInlineTitle` in Obsidian.
         *
         * **Note pages only.** A folder listing, a tag page and the 404 have no
         * note behind them, so their heading is the only thing naming them and
         * it is not this switch's business. Obsidian Publish has no such pages,
         * so hiding the inline title never meant them.
         */
        inlineTitle: z.boolean().default(true),
        /** v2 */
        graph: z.boolean().default(false),
        search: z.boolean().default(false),
        hoverPreview: z.boolean().default(false),
        /** `/rss.xml`, written at build. Requires `url` (see the root refine). */
        rss: z.boolean().default(false),
        /**
         * Click-to-play for a remote video, and a real card for a tweet.
         *
         * On, `![](https://youtu.be/…)` becomes a poster with a play control
         * and **no `<iframe>` in the HTML at all**; the player is fetched when
         * the reader clicks, which is the click that consents to it. Off, a
         * remote URL is the link card it has always been.
         *
         * The poster is local. It is downloaded at build time by
         * `scripts/fetch-content.mjs` into the vault's attachments, because a
         * facade that fetches its own thumbnail from `i.ytimg.com` is the third
         * party this whole design exists to keep off the page.
         */
        embeds: z.boolean().default(true),
      })
      .prefault({}),

    /** Transclusion depth before jotter stops and says so. */
    transcludeDepth: z.number().int().min(0).max(6).default(3),

    /**
     * How a link that leaves the site is dressed.
     *
     * Two deliberate departures from Obsidian Publish, which uses
     * `class="external-link" rel="noopener nofollow" target="_blank"` plus a
     * glyph:
     *
     * - **The new tab is announced, not only drawn.** WCAG technique G201 asks
     *   for a warning *in advance*, and SC 1.1.1 means an icon is not one, so
     *   jotter also puts a visually-hidden "(opens in a new tab)" inside the
     *   anchor. Obsidian Publish does not; that is a bug in Obsidian Publish,
     *   not a specification to copy.
     * - **No blanket `nofollow`.** On a personal knowledge site the outbound
     *   links are editorial citations, and `nofollow`ing every one of them
     *   withholds credit from the sources the author is recommending. jotter
     *   ships `rel="noopener"` and nothing else.
     *
     * Deliberately *not* mapped from an Open Publish site option: three more
     * options is too high a price for a preference with a defensible default.
     */
    externalLinks: z
      .object({
        /** `target="_blank"`, with the screen-reader warning that owes. */
        newTab: z.boolean().default(true),
        /**
         * The `↗` after the link text, drawn from `.external-link` in CSS.
         * Off means the class is absent rather than the glyph hidden, so
         * nothing is rendered and then styled away.
         */
        icon: z.boolean().default(true),
      })
      .strict()
      .prefault({}),

    /**
     * Off by default, and the only switch in jotter that adds a request to
     * somebody else's server. Both refinements exist so that a misconfiguration
     * is a build error naming the key rather than a site that silently collects
     * nothing: degrade loudly, the way the vault integration already does.
     *
     * There is deliberately no `custom` provider and no `src`. A field taking
     * an arbitrary script URL is one the origin assertion in
     * `scripts/verify-build.mjs` cannot check, and an assertion with a hole
     * shaped like "anything the user typed" is not an assertion. Put your own
     * snippet in `src/user/Head.astro`, which renders last in `<head>` and is
     * in the one directory this theme never writes to. (It used to say
     * `src/layouts/Base.astro`, which is among the files an update changes most
     * often: that advice bought a working analytics tag at the price of a merge
     * conflict on every upgrade.)
     */
    analytics: z
      .object({
        provider: z.enum(analyticsProviders).default('none'),
        /** Site id, domain, or token, depending on the provider. */
        id: z.string().optional(),
        /** Self-hosted endpoint for Plausible, Umami or GoatCounter. */
        host: z.url().optional(),
      })
      /**
       * Strict here as well as at the root, because the root's `.strict()` does
       * *not* cascade into a nested object: without this, `src:` left behind
       * from a pre-1.0 config would be stripped in silence rather than named.
       */
      .strict()
      .refine((a) => a.provider === 'none' || !!a.id, {
        path: ['id'],
        message: 'is required unless `provider` is \'none\'',
      })
      .refine((a) => !a.host || selfHostable.includes(a.provider), {
        path: ['host'],
        message: 'applies to plausible, umami and goatcounter only; the rest are vendor-hosted',
      })
      .prefault({}),

    /** Extra redirects, on top of the ones `aliases:` generates. */
    redirects: z.record(z.string(), z.string()).default({}),

    /**
     * Display names for folders whose path on disk is not what to call them,
     * keyed by the folder's path relative to the vault.
     *
     * Empty for an ordinary vault, where the folder *is* its name. It is filled
     * in on an Open Publish build, which writes every note to its slug: there
     * `Wisdom & Approaches/Critical Thinking.md` is on disk at
     * `wisdom-approaches/critical-thinking.md`, and without this the sidebar,
     * the breadcrumbs and the folder pages would all read `wisdom-approaches`.
     * `scripts/fetch-content.mjs` recovers the real names from the manifest,
     * which is keyed by vault path.
     *
     * A folder that is not named here keeps its own last path segment, so this
     * is a set of corrections rather than a table anybody has to complete.
     */
    folderNames: z.record(z.string(), z.string()).default({}),

    /**
     * The sidebar order somebody arranged in Obsidian, as slugs, for the
     * parents they actually arranged. A parent named nowhere in here keeps
     * jotter's own default order, which is what an ordinary vault gets: this is
     * empty unless an Open Publish snapshot filled it in.
     *
     * A folder is named by the slug of its index page, so the folder served at
     * `/notes` is `notes/index`. That is the plugin's contract, and it is the
     * one shape that can tell a folder apart from a note wanting the same URL.
     *
     * One flat list covers every parent at once. Entries are only ever compared
     * with their own siblings, so a single running index orders each parent on
     * its own without any grouping being written down twice.
     */
    navOrder: z.array(z.string()).default([]),

    /**
     * Slugs to leave out of the sidebar, named the same way.
     *
     * **Not access control, and not unpublishing.** Every page named here is
     * still built, still served at its own address, still in the search index,
     * still in the sitemap and still linked to from any note that links to it.
     * Hiding a folder takes everything under it out of the sidebar and changes
     * nothing else about those pages.
     */
    navHidden: z.array(z.string()).default([]),
  })
  .strict()
  /**
   * The constraints spanning two top-level keys, which is why they are here
   * rather than beside either of them.
   *
   * Every link in a feed has to be absolute: a reader resolves them against
   * nothing. So `features.rss` without `url` is not a degraded feed, it is one
   * nobody can follow, and it fails the build naming the key it needs in the
   * same shape as the two analytics refinements above. Degrade loudly.
   */
  .refine((c) => !c.features.rss || !!c.url, {
    path: ['url'],
    message: 'is required when `features.rss` is on: a feed’s links must be absolute',
  })
  /**
   * The same rule, for the same reason, one key over. `og:image` must be
   * absolute (an unfurler has no document to resolve a relative URL against)
   * so a site-wide `image` with no `url` to make it absolute is a card nobody
   * ever draws, silently. A note's own `image:` is frontmatter and cannot fail
   * a build; this one is config, and config says so.
   */
  .refine((c) => !c.image || !!c.url, {
    path: ['url'],
    message: 'is required when `image` is set: an og:image URL must be absolute',
  })

export type JotterConfig = z.infer<typeof jotterConfigSchema>
export type JotterConfigInput = z.input<typeof jotterConfigSchema>

/**
 * Parse and validate. Throws with the offending keys named, because a config
 * error found at build time should not require reading this file to fix.
 */
export function defineConfig(input: JotterConfigInput = {}): JotterConfig {
  const result = jotterConfigSchema.safeParse(input)
  if (result.success) return result.data

  const issues = result.error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)'
      return `  ${path}: ${issue.message}`
    })
    .join('\n')

  throw new Error(
    `jotter.config.ts is not valid:\n${issues}\n\n` +
      `Every field is optional; remove the offending key to take its default.`,
  )
}
