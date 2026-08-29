/**
 * The snapshot's `site` block, as a `jotter.config.ts`.
 *
 * Open Publish's site options are deliberately generator-agnostic *intent* —
 * "show a graph", not "render `LocalGraph.astro` in the right panel" — so the
 * mapping to any one generator is where the intent either lands or quietly
 * does nothing. Three of the twelve keys are traps in exactly that way, and
 * each is handled below with the reason attached:
 *
 * - **`showGraph`** is not enough on its own. `astro.config.ts` gates the graph
 *   island on `features.graph && layout === 'panels'`, because the graph lives
 *   in the right panel and there is no right panel in the column layout. Asking
 *   for a graph therefore also asks for `layout: 'panels'`.
 * - **`analytics`** is build-breaking. The plugin defaults `id` to `''`, and
 *   `src/lib/config.ts` refines `id` as *required* unless the provider is
 *   `none` — so a provider chosen and an id left blank in Obsidian would fail
 *   the whole build on a config error, which is the wrong place for that
 *   sentence to appear. It falls back to `none`, loudly.
 * - **`showNavigation`** is a boolean here and a three-valued enum in jotter
 *   (`tree` | `tags` | `none`). `true` means `tree`; there is no plugin option
 *   that means `tags`.
 *
 * The other keys map straight across, except `homepage`, which is *already*
 * applied: it is a vault path, and the plugin has given that note the slug
 * `index`, which `src/lib/site.ts` picks up on its own. Re-deriving it here
 * would be a second answer to a question that already has one.
 *
 * A key jotter does not understand is reported rather than guessed at — that
 * is how somebody finds out to update this repository from the template.
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
  noIndex: false,
  showThemeToggle: true,
  strictLineBreaks: false,
  showNavigation: true,
  showSearch: true,
  showGraph: true,
  showOutline: true,
  showBacklinks: true,
  showTags: true,
  analytics: { provider: 'none', id: '' },
}

/**
 * `analyticsProviders` from `src/lib/config.ts`, which this script cannot
 * import: it is TypeScript, and this runs under plain Node before any bundler
 * exists. `test/snapshot.test.ts` asserts the two lists are identical rather
 * than trusting this comment — a provider added there and missed here would
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
 * by hand — a key renamed there is an error here.
 *
 * @param rawSite  the snapshot's `site`, or anything at all
 * @param options  `{ url }` from `resolveSiteUrl`
 * @returns {{
 *   options: import('../../src/lib/config.js').JotterConfigInput,
 *   notes: string[],
 *   warnings: string[],
 * }} the config, the lines worth printing, and the places jotter did something
 *   other than what was asked.
 */
export function mapSite(rawSite, { url } = {}) {
  const site = { ...DEFAULT_SITE }
  for (const key of Object.keys(DEFAULT_SITE)) {
    if (rawSite?.[key] !== undefined) site[key] = rawSite[key]
  }
  site.analytics = { ...DEFAULT_SITE.analytics, ...(rawSite?.analytics ?? {}) }

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
     * The vault was published at the plugin's slugs, and those slugs are the
     * filenames this build writes. `preserve` is the one style that carries a
     * path to the URL untouched, which is the whole contract: jotter serves the
     * addresses it was given rather than the ones it would have invented.
     */
    slugs: 'preserve',

    noIndex: !!site.noIndex,
    strictLineBreaks: !!site.strictLineBreaks,

    layout: graph ? 'panels' : 'column',
    nav: site.showNavigation ? 'tree' : 'none',

    features: {
      toc: !!site.showOutline,
      backlinks: !!site.showBacklinks,
      tags: !!site.showTags,
      themeToggle: !!site.showThemeToggle,
      graph,
      search: !!site.showSearch,
    },

    analytics: analyticsFor(site.analytics, warnings),
  }

  return { options, notes, warnings }
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
 * The config object as the source of `jotter.config.ts`.
 *
 * `JSON.stringify` rather than a hand-rolled printer: JSON is a subset of the
 * object literal syntax TypeScript accepts, quoted keys and all, and a
 * generated file has nothing to gain from looking hand-written. The banner is
 * the part that matters — this file is a build artifact that happens to live at
 * a path a forker owns, and the next person to open it needs to know that
 * before they edit it.
 */
export function renderConfig(options, { snapshot } = {}) {
  return (
    `// Generated by Open Publish from the published snapshot${snapshot ? ` ${snapshot}` : ''}.\n` +
    `//\n` +
    `// Do not hand-edit. \`scripts/fetch-content.mjs\` overwrites this file on every\n` +
    `// build, from the site options in Obsidian: Settings > Open Publish > Site options.\n` +
    `// Styling stays yours, in \`src/styles/custom.css\`; so do the strings in \`src/i18n/\`.\n` +
    `import { defineConfig } from './src/lib/config'\n` +
    `\n` +
    `export default defineConfig(${JSON.stringify(options, null, 2)})\n`
  )
}
