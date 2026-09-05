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

import jotter from './jotter.config'
import { resolveVaultRoot, scanVault } from './src/lib/vault'
import { buildGraph } from './src/lib/graph'
import { jotterPlugins, jotterHastPlugins, satteriFeatures } from './src/markdown'
import { jotterVault } from './src/integrations/vault'
import { jotterSearch } from './src/integrations/search'
import { buildRedirectRules } from './src/lib/redirects'
import { buildTree, folders, resolveAllNotes, shadowedFolders } from './src/lib/tree'
import { decodeSlug, encodeSlug } from './src/lib/url'

/**
 * Resolved once, here, and injected into the client/server bundle below.
 * `src/lib/site.ts` must not recompute this from `import.meta.url`: that file
 * is bundled by Vite, so by the time it runs its own URL no longer points at
 * the source tree and the scan silently finds an empty vault.
 *
 * Through `resolveVaultRoot` rather than inline, so that this file and
 * `src/lib/site.ts` cannot resolve the same configured path against two
 * different bases. They used to; see the docstring there.
 */
const vaultRoot = resolveVaultRoot(jotter.vault)

const vault = scanVault({
  root: vaultRoot,
  publishGate: jotter.publishGate,
  homepage: jotter.homepage,
  image: jotter.image,
  slugs: jotter.slugs,
})
const graph = buildGraph(vault, jotter.linkResolution)

const published = vault.notes.filter((note) => note.published)

const tree = buildTree(published, vault.slugs, jotter.folderNames, {
  order: jotter.navOrder,
  hidden: jotter.navHidden,
})

/** Every slug this build routes: a note page, or a folder index above one. */
const routed = [...published.map((note) => note.slug), ...folders(tree).map((f) => f.slug)]

/**
 * A folder and a note that both want one URL.
 *
 * `src/pages/[...slug].astro` resolves it (the note wins, the folder gets no
 * index page) and that is the right call, but it resolved it with a
 * `console.warn` inside `getStaticPaths`, which is a line in the middle of a
 * page-build log that Astro may not even re-run on a warm build. On
 * `navidk.com` the folder `About/` and the note `About/About.md` carrying
 * `permalink: about` collide exactly this way: the sidebar says `About (6)`,
 * draws the note among the folder's own children, and links to the note.
 *
 * Still worth reporting after `buildTree` learned to draw a folder note inside
 * its folder. The sidebar is tidy now, but the fact underneath has not changed:
 * two things wanted one URL and one of them has no page of its own.
 *
 * Detected in `src/lib/tree.ts`, where it can be tested, and reported by the
 * integration, which is the channel a person reading a build log actually sees.
 */
const shadowed = shadowedFolders(tree, published)

/**
 * Where the all-notes listing ends up, and what pushed it there if anything
 * did. `Notes/` is an ordinary name for a vault folder and slugifies to
 * `notes`, the URL jotter's own listing wants; the vault wins and the listing
 * moves aside. See `resolveAllNotes` in `src/lib/tree.ts`.
 *
 * Resolved here as well as in `src/lib/site.ts` because this file owns two
 * things that must agree with the route: the redirect map, which must not
 * shadow it, and the build report. Both read the same pure function, so they
 * cannot drift.
 */
const allNotes = resolveAllNotes(tree, published)

/**
 * Feed inputs, or nothing at all.
 *
 * Built here and only when the flag is on, so `features.rss: false` means the
 * integration never receives the option and never writes the file: the same
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
    }
  : undefined

const redirects = buildRedirectRules({
  notes: published,
  slugs: vault.slugs,
  taken: [
    ...routed,
    // Routes jotter owns itself. The listing's slug rather than a literal
    // `notes`: on a vault that took `/notes` the listing is somewhere else,
    // and it is the somewhere else a redirect must not shadow.
    allNotes.slug,
    'tags',
    '404',
  ],
  extra: jotter.redirects,
})

export default defineConfig({
  site: jotter.url,
  trailingSlash: 'never',

  /**
   * The other half of `trailingSlash: 'never'`.
   *
   * `trailingSlash` governs which requests Astro's dev server *matches*;
   * `build.format` governs what it *writes*, and the default (`directory`)
   * writes `dist/welcome/index.html`. Every host then normalises `/welcome` to
   * `/welcome/` with a 308, so every internal link on the site (all of which
   * jotter spells without a slash) took a redirect before it reached a page,
   * and the sitemap advertised 96 URLs that redirect. Astro's own reference
   * names two coherent pairings, `directory`+`always` and `file`+`never`; this
   * file had half of the second one.
   *
   * `file` writes `dist/welcome.html`. Cloudflare's default asset routing is
   * `auto-trailing-slash`, so with that file present `/welcome` is served
   * directly and `/welcome/` 301s to it: anything already indexed at the
   * trailing-slash form is cleaned up without a `_redirects` rule, which
   * matters because a Pages splat cannot strip a trailing slash. It also
   * collapses the legacy chain `/Welcome` -> `/welcome` -> `/welcome/` to one
   * hop.
   */
  build: { format: 'file' },

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
      hastPlugins: jotterHastPlugins(vault, jotter),
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
       * 300 end of the range exists at all: the static set started at 400, so
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
       * New: the difference between them is that the mono face is static and
       * this one is variable, which is where the metrics read goes wrong.
       *
       * Off, so the fallback is the stack above: `ui-sans-serif` is the system
       * UI face, close enough to Public Sans that the swap is a change of
       * typeface rather than of size. Worth re-testing when Astro updates:
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
       * mono face is never italic anywhere in the theme: the two italic rules
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
      shadowedFolders: shadowed,
      allNotes,
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
    ...(jotter.url && !jotter.noIndex
      ? [
          sitemap({
            /**
             * The third of the four producers of a page's URL, brought into
             * line with the other three.
             *
             * `@astrojs/sitemap` builds each entry as `new URL(fullPath, site)`
             * off the same WHATWG pathname `Base.astro`'s canonical link used
             * to take, so a slug carrying `&` or `+` was spelled one way in
             * every `<a href>` and another way here, and sitemaps.org requires
             * percent-encoding, while Google's URL guidelines say a link, a
             * canonical and a sitemap entry that disagree split one page into
             * duplicates. The same round trip as the canonical, for the same
             * reason. XML entity escaping is the `sitemap` package's job and it
             * does it; emitting `%26` means no raw `&` reaches the XML at all.
             */
            serialize: (item) => {
              const url = new URL(item.url)
              url.pathname = encodeSlug(decodeSlug(url.pathname))
              return { ...item, url: url.href }
            },
          }),
        ]
      : []),
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
       * `LocalGraph.astro` entirely, which takes the component (and so its
       * script) out of the module graph.
       */
      'import.meta.env.JOTTER_GRAPH': JSON.stringify(
        jotter.features.graph && jotter.layout === 'panels',
      ),

      /**
       * The same trap, for the same reason. `HoverPreview.astro` is nothing but
       * a `<script>`, so left as a plain `config.features.hoverPreview` test it
       * would ship its bundle on every note page with the feature off: the
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

      /**
       * And once more, for the island that turns a video facade into a player.
       * `Embeds.astro` is nothing but a `<script>`, so a plain
       * `config.features.embeds` test would ship its bundle on every note page
       * with the feature off, which on this feature would be the worse half to
       * get wrong: the markup half honouring it means there is no facade for
       * the script to upgrade, and the script would sit there for nothing.
       */
      'import.meta.env.JOTTER_EMBEDS': JSON.stringify(jotter.features.embeds),
    },
  },

})
