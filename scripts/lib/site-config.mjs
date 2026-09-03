/**
 * The snapshot's `site` block, as the options overlay a jotter build reads.
 *
 * Open Publish's site options are deliberately generator-agnostic *intent*
 * ("show a graph", not "render `LocalGraph.astro` in the right panel"), so the
 * mapping to any one generator is where the intent either lands or quietly
 * does nothing. Three of the sixteen keys are traps in exactly that way, and
 * each is handled below with the reason attached:
 *
 * - **`showGraph`** is not enough on its own. `astro.config.ts` gates the graph
 *   island on `features.graph && layout === 'panels'`, because the graph lives
 *   in the right panel and there is no right panel in the column layout. Asking
 *   for a graph therefore also asks for `layout: 'panels'`.
 * - **`analytics`** is build-breaking. The plugin defaults `id` to `''`, and
 *   `src/lib/config.ts` refines `id` as *required* unless the provider is
 *   `none`, so a provider chosen and an id left blank in Obsidian would fail
 *   the whole build on a config error, which is the wrong place for that
 *   sentence to appear. It falls back to `none`, loudly.
 * - **`showNavigation`** is a boolean here and a three-valued enum in jotter
 *   (`tree` | `tags` | `none`). `true` means `tree`; there is no plugin option
 *   that means `tags`.
 * - **`nav`** collides by name with that enum, so the arrangement it carries
 *   lands on two keys of jotter's own, `navOrder` and `navHidden`. Both are
 *   omitted when empty, so a site nobody has arranged generates the same config
 *   file it generated before this option existed.
 *
 * The other keys map straight across, except `homepage`, which is *already*
 * applied: it is a vault path, and the plugin has given that note the slug
 * `index`, which `src/lib/site.ts` picks up on its own. Re-deriving it here
 * would be a second answer to a question that already has one.
 *
 * A key jotter does not understand is reported rather than guessed at: that
 * is how somebody finds out their site is running a jotter older than the
 * plugin that published to it. See `docs/updating.md`.
 */

/**
 * Every site option this starter understands, with the plugin's own default.
 *
 * The snapshot is merged **over** these rather than replacing them, and that
 * matters: a snapshot published by an older plugin will not carry keys added
 * since, `undefined` is falsy, and replacing wholesale would silently switch
 * off search, navigation and backlinks on somebody's live site.
 */
export const DEFAULT_SITE = {
  title: '',
  /** A vault path. Applied by the plugin, which gives that note the slug `index`. */
  homepage: '',
  /** BCP-47 tag. The plugin sends region-qualified tags, e.g. `fa-IR`. */
  locale: 'en',
  /** Derived by the plugin from `locale`, never set on its own there. */
  dir: 'ltr',
  noIndex: false,
  showThemeToggle: true,
  strictLineBreaks: false,
  showNavigation: true,
  showSearch: true,
  showGraph: true,
  showOutline: true,
  showBacklinks: true,
  showTags: true,
  /** Off in the plugin too, the way Obsidian Publish is. */
  showPageMetadata: false,
  showPrevNext: true,
  /**
   * The sidebar somebody arranged, as slugs, and the pages left out of it.
   * Empty until they arrange one, and empty is exactly jotter's own default
   * order, so an untouched site renders what it always did.
   */
  nav: { order: [], hidden: [] },
  analytics: { provider: 'none', id: '' },
}

/**
 * `analyticsProviders` from `src/lib/config.ts`, which this script cannot
 * import: it is TypeScript, and this runs under plain Node before any bundler
 * exists. `test/snapshot.test.ts` asserts the two lists are identical rather
 * than trusting this comment: a provider added there and missed here would
 * otherwise be a build that dies on a zod enum error naming a key the person
 * never typed.
 */
export const ANALYTICS_PROVIDERS = [
  'none',
  'plausible',
  'umami',
  'goatcounter',
  'fathom',
  'cloudflare',
  'google',
]

/**
 * `site` block -> the object handed to `defineConfig`.
 *
 * The return type is jotter's own `JotterConfigInput`, so `astro check` compares
 * this mapping against `src/lib/config.ts` rather than leaving the two to agree
 * by hand: a key renamed there is an error here.
 *
 * @param rawSite  the snapshot's `site`, or anything at all
 * @param options  `{ url }` from `resolveSiteUrl`, `{ folderNames }` from
 *   `folderNamesFor`, and `{ vault }`: the directory this run actually wrote
 *   the notes to. None of the three is a site option; all three are things only
 *   the build knows.
 * @returns {{
 *   options: import('../../src/lib/config.js').JotterConfigInput,
 *   notes: string[],
 *   warnings: string[],
 * }} the config, the lines worth printing, and the places jotter did something
 *   other than what was asked.
 */
export function mapSite(rawSite, { url, folderNames, vault } = {}) {
  const site = { ...DEFAULT_SITE }
  for (const key of Object.keys(DEFAULT_SITE)) {
    if (rawSite?.[key] !== undefined) site[key] = rawSite[key]
  }
  site.analytics = { ...DEFAULT_SITE.analytics, ...(rawSite?.analytics ?? {}) }
  // Field by field, like analytics above and for the same reason: a snapshot
  // carrying half of this must not leave the other half `undefined`, which the
  // schema would then reject with a message about a key nobody typed.
  site.nav = { order: slugList(rawSite?.nav?.order), hidden: slugList(rawSite?.nav?.hidden) }

  /** @type {string[]} */
  const notes = []
  /** @type {string[]} */
  const warnings = []

  const unknown = Object.keys(rawSite ?? {}).filter((key) => !(key in DEFAULT_SITE))
  if (unknown.length > 0) {
    notes.push(
      `ignoring site option(s) this version of jotter does not support: ${unknown.join(', ')}`,
    )
  }

  const graph = !!site.showGraph
  if (graph) {
    notes.push("the graph needs the two-panel layout, so layout is 'panels'")
  }

  const options = {
    ...(site.title ? { title: String(site.title) } : {}),
    ...(url ? { url } : {}),

    /**
     * Where `fetch-content.mjs` just wrote the notes, carried into the config so
     * that the script writing the vault and the four readers of it cannot
     * disagree. They used to: the script wrote a hardcoded `src/content/notes`
     * while `astro.config.ts`, `src/content.config.ts` and `src/lib/site.ts` all
     * read `jotter.vault`, so setting `vault:` published an empty site.
     */
    ...(vault ? { vault } : {}),

    /**
     * The vault was published at the plugin's slugs, and those slugs are the
     * filenames this build writes. `preserve` is the one style that carries a
     * path to the URL untouched, which is the whole contract: jotter serves the
     * addresses it was given rather than the ones it would have invented.
     */
    slugs: 'preserve',

    noIndex: !!site.noIndex,
    strictLineBreaks: !!site.strictLineBreaks,

    /**
     * The two that map straight across: jotter's config already has exactly
     * these fields, with these names and these types. `dir` is stored rather
     * than derived here on purpose, so that the plugin stays the one place that
     * decides which languages read right to left.
     */
    locale: String(site.locale),
    dir: site.dir === 'rtl' ? 'rtl' : 'ltr',

    layout: graph ? 'panels' : 'column',
    nav: site.showNavigation ? 'tree' : 'none',

    /**
     * The sidebar arrangement, straight across. Two flat lists here rather than
     * the snapshot's one nested key because `nav` is already taken in this
     * config, by the three-valued sidebar mode a few lines up.
     *
     * Emitted only when there is something to say, so an ordinary build's
     * generated config is exactly the file it was before this existed.
     */
    ...(site.nav.order.length > 0 ? { navOrder: site.nav.order } : {}),
    ...(site.nav.hidden.length > 0 ? { navHidden: site.nav.hidden } : {}),

    /**
     * Not a site option: a repair. Every note is written to its slug, so the
     * folder tree jotter derives from the paths on disk would read
     * `wisdom-approaches` where the vault reads `Wisdom & Approaches`. The real
     * names are recovered from the manifest, which is keyed by vault path.
     */
    ...(folderNames && Object.keys(folderNames).length > 0 ? { folderNames } : {}),

    features: {
      toc: !!site.showOutline,
      backlinks: !!site.showBacklinks,
      tags: !!site.showTags,
      themeToggle: !!site.showThemeToggle,
      graph,
      search: !!site.showSearch,
      metadata: !!site.showPageMetadata,
      prevNext: !!site.showPrevNext,
    },

    analytics: analyticsFor(site.analytics, warnings),
  }

  return { options, notes, warnings }
}

/** Slugs only: a snapshot is data off the network, so neither list is trusted. */
function slugList(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : []
}

/**
 * The one mapping that can fail a build rather than merely look wrong, so it
 * degrades to `none` and says which of the two things went missing.
 */
function analyticsFor(analytics, warnings) {
  const provider = String(analytics?.provider ?? 'none')
  const id = String(analytics?.id ?? '').trim()

  if (provider === 'none') return { provider: 'none' }

  if (!ANALYTICS_PROVIDERS.includes(provider)) {
    warnings.push(
      `analytics provider "${provider}" is not one jotter can emit ` +
        `(${ANALYTICS_PROVIDERS.join(', ')}), so analytics are off. Update this repository ` +
        `from the template if the plugin has learned a new one.`,
    )
    return { provider: 'none' }
  }

  if (!id) {
    warnings.push(
      `analytics is set to "${provider}" with no site id, which jotter cannot emit a tag ` +
        `for, so analytics are off. Add the id in Obsidian, under ` +
        `Settings > Open Publish > Site options.`,
    )
    return { provider: 'none' }
  }

  return { provider, id }
}

/**
 * The mapped options as the file `src/lib/generated.ts` reads.
 *
 * JSON rather than the TypeScript this used to emit, and written to
 * `.jotter/site.json` rather than to `jotter.config.ts`, for one reason: the
 * config file is tracked in git and named in the README as a file a forker owns.
 * A build that rewrites it hands the user a dirty working tree whose obvious
 * next move is `git commit -a`, and from then on every upstream change to that
 * path is a merge conflict. Nothing in `.jotter/` is tracked, so nothing in it
 * can conflict.
 *
 * `generatedFrom` is the snapshot, kept because it is the one question anybody
 * debugging a stale-looking site actually asks. It is a sibling of `options`
 * rather than a key inside it, so that everything under `options` is exactly
 * what `defineConfig` takes and nothing has to be stripped before it gets there.
 */
export function renderSiteJson(options, { snapshot } = {}) {
  return (
    JSON.stringify({ generatedFrom: snapshot ?? null, options }, null, 2) + '\n'
  )
}
