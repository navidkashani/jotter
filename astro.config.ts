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
import { scanVault } from './src/lib/vault'
import { buildGraph } from './src/lib/graph'
import { jotterPlugins, satteriFeatures } from './src/markdown'
import { jotterVault } from './src/integrations/vault'
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
const redirects = buildRedirects({
  notes: published,
  taken: [
    ...published.map((note) => note.slug),
    ...folders(buildTree(published)).map((folder) => folder.slug),
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
    }),
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
    },
  },

})
