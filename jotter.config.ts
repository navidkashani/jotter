import { defineConfig } from './src/lib/config'
import { generated } from './src/lib/generated'

/**
 * Yours. Along with `src/styles/custom.css`, `src/user/*.astro`, your vault
 * folder and `src/i18n/*.json`, this is the whole surface you own, and **nothing
 * in the build writes to any of them**. That is what makes updating jotter a
 * button rather than a merge.
 *
 * Every field is optional. `defineConfig({})` builds a working site.
 *
 * `generated ??` is for sites fed by Open Publish: there the options come from
 * Obsidian, are written to `.jotter/site.json` on every build, and replace this
 * literal outright rather than merging with it. See `src/lib/generated.ts` for
 * why replacement is the only correct answer. Edit below anyway if you like: the
 * file is yours, it is never overwritten, and it is what a build with no
 * snapshot uses.
 */
export default defineConfig(
  generated ?? {
    title: 'Slipbox',
    description: 'A garden of notes, published with jotter.',
    // url: 'https://example.com',   // set this for sitemap, RSS and canonical links
    author: '',

    locale: 'en',
    dir: 'ltr',

    // Where your notes live, relative to this file. Point it at your own folder
    // rather than emptying the demo garden: deleting a file jotter ships is a
    // modify/delete conflict on every future update, and moving on is free.
    vault: 'src/content/notes',

    layout: 'panels',
    nav: 'tree',

    // Obsidian's own default. Change only if your vault was written for another tool.
    linkResolution: 'shortest',
    publishGate: 'all',

    features: {
      toc: true,
      backlinks: true,
      tags: true,
      themeToggle: true,
      graph: true,
      hoverPreview: true,
      search: true,
      // On here, off by default. The demo garden is in git, so its notes have
      // real dates to show; a vault with none would show the day of the build,
      // which is why the default is the other way.
      metadata: true,
      prevNext: true,
    },
  },
)
