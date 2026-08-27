/**
 * Ours, not yours. Site settings live in `jotter.config.ts`.
 *
 * The ordering problem this file solves: wikilinks must resolve *during*
 * markdown render, but `getCollection()` only exists *after*. So the vault is
 * scanned here, synchronously, at config load, and the same index is handed to
 * the markdown plugins and (via `src/lib/site.ts`) to every page.
 */
import { defineConfig, fontProviders } from 'astro/config'
import { satteri } from '@astrojs/markdown-satteri'
import sitemap from '@astrojs/sitemap'
import { fileURLToPath } from 'node:url'

import jotter from './jotter.config'
import { scanVault, homepageNote } from './src/lib/vault'
import { buildGraph } from './src/lib/graph'
import { jotterPlugins, satteriFeatures } from './src/markdown'
import { jotterVault } from './src/integrations/vault'
import { jotterSearch } from './src/integrations/search'
import { buildRedirects } from './src/lib/redirects'
import { buildTree, folders } from './src/lib/tree'

/**
 * Resolved once, here, and injected into the client/server bundle below.
 * `src/lib/site.ts` must not recompute this from `import.meta.url`: that file
 * is bundled by Vite, so by the time it runs its own URL no longer points at
 * the source tree and the scan silently finds an empty vault.
 */
const vaultRoot =
  process.env.JOTTER_VAULT_OVERRIDE ?? fileURLToPath(new URL(jotter.vault, import.meta.url))

const vault = scanVault({ root: vaultRoot, publishGate: jotter.publishGate })
const graph = buildGraph(vault, jotter.linkResolution)

const published = vault.notes.filter((note) => note.published)

/** Every slug this build routes: a note page, or a folder index above one. */
const routed = [
  ...published.map((note) => note.slug),
  ...folders(buildTree(published)).map((folder) => folder.slug),
]

/**
 * Feed inputs, or nothing at all.
 *
 * Built here and only when the flag is on, so `features.rss: false` means the
 * integration never receives the option and never writes the file — the same
 * shape as `search off writes no dist/pagefind/`, rather than a file emitted
 * and then cleaned up.
 *
 * `jotter.url!` is asserted, not guarded. The schema refuses `features.rss`
 * without `url` and names the key, so a build that reaches this line has one;
 * a `&& jotter.url` here would turn that loud config error into a silently
 * missing feed.
 */
const feed = jotter.features.rss
  ? {
      title: jotter.title,
      description: jotter.description,
      siteUrl: jotter.url!,
      locale: jotter.locale,
      author: jotter.author || undefined,
      homepageSlug: homepageNote(vault, jotter.homepage)?.slug,
    }
  : undefined

const redirects = buildRedirects({
  notes: published,
  taken: [
    ...routed,
    // Routes jotter owns itself.
    'notes',
    'tags',
    '404',
  ],
  extra: jotter.redirects,
})

export default defineConfig({
  site: jotter.url,
  trailingSlash: 'never',

  /**
   * Astro 7 changed this default from `true` to `'jsx'`, which strips
   * whitespace between inline elements the way React does. On a theme whose
   * whole point is prose, losing the space in `<em>word</em> <a>link</a>` is a
   * real bug, so it is set explicitly and `scripts/verify-build.mjs` asserts
   * against it rather than trusting the default.
   */
  compressHTML: true,

  markdown: {
    processor: satteri({
      features: satteriFeatures,
      mdastPlugins: jotterPlugins(vault, jotter),
      hastPlugins: [],
    }),
    // Astro composes [highlighter] -> [hastPlugins] -> [image marker] ->
    // [heading ids] regardless of processor, so Shiki and anchor ids are free.
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      wrap: false,
    },
  },

  fonts: [
    {
      provider: fontProviders.google(),
      name: 'Public Sans',
      cssVariable: '--font-sans',
      /**
       * One variable axis rather than four static cuts: fewer files, and the
       * 300 end of the range exists at all — the static set started at 400, so
       * anything asking for light silently got regular.
       */
      weights: ['300 700'],
      styles: ['normal', 'italic'],
      subsets: ['latin', 'latin-ext'],
      fallbacks: ['ui-sans-serif', 'system-ui', 'sans-serif'],
      /**
       * Astro's metric-matched fallback is *wrong* for this face, and wrong in
       * the most visible way there is: it emitted
       *
       *   @font-face { font-family: "Public Sans … fallback: Arial";
       *                src: local("Arial"); size-adjust: 169.9189%; … }
       *
       * and prepended it to `--font-sans`, so every first paint before the real
       * font arrives rendered Arial at 170% and then snapped back. Public Sans
       * and Arial have near-identical x-heights; the honest number is around
       * 100%. The same build computes 99.98% for IBM Plex Mono against Courier
       * New — the difference between them is that the mono face is static and
       * this one is variable, which is where the metrics read goes wrong.
       *
       * Off, so the fallback is the stack above: `ui-sans-serif` is the system
       * UI face, close enough to Public Sans that the swap is a change of
       * typeface rather than of size. Worth re-testing when Astro updates —
       * a correct optimized fallback is better than an unoptimized one.
       */
      optimizedFallbacks: false,
    },
    {
      provider: fontProviders.google(),
      name: 'IBM Plex Mono',
      cssVariable: '--font-mono',
      weights: [400, 500],
      /**
       * Normal only. Astro requests both styles when this is unset, and the
       * mono face is never italic anywhere in the theme — the two italic rules
       * in `prose.css` are on a blockquote and a stopped transclusion, both
       * body font. Four files, built and served for nothing.
       */
      styles: ['normal'],
      subsets: ['latin', 'latin-ext'],
      fallbacks: ['ui-monospace', 'SFMono-Regular', 'monospace'],
    },
  ],

  integrations: [
    jotterVault({
      vault,
      graph,
      redirects,
      noIndex: jotter.noIndex,
      siteUrl: jotter.url,
      feed,
    }),
    /**
     * After the vault integration, so `dist/` is finished before Pagefind
     * reads it. Registered at all only when the flag is on: the integration
     * imports `pagefind` lazily, but an unconditional registration would still
     * put an indexing pass, and a `dist/pagefind/`, into every build.
     */
    ...(jotter.features.search ? [jotterSearch({ locale: jotter.locale, slugs: routed })] : []),
    // A site that asked not to be indexed should not hand out a map of itself.
    ...(jotter.url && !jotter.noIndex ? [sitemap()] : []),
  ],

  image: {
    responsiveStyles: true,
  },

  vite: {
    define: {
      'import.meta.env.JOTTER_VAULT_ROOT': JSON.stringify(vaultRoot),

      /**
       * The graph is the first island heavy enough to become a real file in
       * `dist/` rather than a tag Astro inlines, and that exposes a rule the
       * small ones never did: a component's script is bundled because the
       * component is *imported*, whether or not it ever renders. Left as a
       * plain `config.features.graph` test, `features.graph: false` would ship
       * an 18 KB chunk no page loads.
       *
       * A literal here is what Rollup needs to drop the import of
       * `LocalGraph.astro` entirely, which takes the component — and so its
       * script — out of the module graph.
       */
      'import.meta.env.JOTTER_GRAPH': JSON.stringify(
        jotter.features.graph && jotter.layout === 'panels',
      ),

      /**
       * The same trap, for the same reason. `HoverPreview.astro` is nothing but
       * a `<script>`, so left as a plain `config.features.hoverPreview` test it
       * would ship its bundle on every note page with the feature off — the
       * markup half of the flag would honour it and the JavaScript half would
       * not.
       */
      'import.meta.env.JOTTER_HOVER_PREVIEW': JSON.stringify(jotter.features.hoverPreview),

      /**
       * The same trap again, and this one is the widest of the three:
       * `Search.astro` is mounted from `Base.astro`, so left as a plain
       * `config.features.search` test its script would ship on *every page of
       * the site* with the feature off.
       */
      'import.meta.env.JOTTER_SEARCH': JSON.stringify(jotter.features.search),
    },
  },

})
