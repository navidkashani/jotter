import { defineConfig } from './src/lib/config'

/**
 * Yours. Along with `src/styles/custom.css`, `src/content/notes/` and
 * `src/i18n/*.json`, this is the whole surface you own; everything else is
 * upstream and merges cleanly.
 *
 * Every field is optional. `defineConfig({})` builds a working site.
 */
export default defineConfig({
  title: 'Slipbox',
  description: 'A garden of notes, published with jotter.',
  // url: 'https://example.com',   // set this for sitemap, RSS and canonical links
  author: '',

  locale: 'en',
  dir: 'ltr',

  layout: 'column',
  nav: 'tree',

  // Obsidian's own default. Change only if your vault was written for another tool.
  linkResolution: 'shortest',
  publishGate: 'all',

  features: {
    toc: true,
    backlinks: true,
    tags: true,
    themeToggle: true,
  },
})
