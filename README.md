# jotter

An Astro theme for publishing an Obsidian vault, **designed** rather than
merely generated.

Point it at a folder of markdown and it works. The entire visual system is
about forty CSS custom properties in one file, so changing the accent changes
the site.

```bash
# Use this template on GitHub, then:
npm install
npm run dev
```

Your notes go in `src/content/notes/`. Delete the demo garden that ships there
and drop your vault in its place — a folder, a symlink, or a git submodule.

---

## Three things jotter does that Quartz does not

**Links resolve exactly like Obsidian.** Quartz's `CrawlLinks` defaults
`markdownLinkResolution` to `absolute`; Obsidian's own default is *shortest
path*. A vault written against Obsidian's default and published through
Quartz's gets links that worked in the app and 404 on the site. jotter defaults
to `shortest`.

**The whole theme is one token file.** No Tailwind, no SCSS, no second styling
idiom for prose. `src/styles/tokens.css` holds every colour, space, type step,
radius and duration; the build fails on a colour literal anywhere else.

**Wikilinks are parsed by the markdown engine, not by a regex over your prose.**
Quartz hand-rolls `[[…]]` detection. jotter's engine parses it natively, which
is why a `[[link]]` inside a code fence survives untouched with no special
handling.

---

## The two files you own

Everything else is upstream and merges cleanly.

| File | What it is |
| --- | --- |
| `jotter.config.ts` | Site settings. Every field optional. |
| `src/styles/custom.css` | Your CSS. Loads last. Override tokens, not rules. |

Plus your content: `src/content/notes/` and `src/i18n/*.json`.

### Config reference

```ts
import { defineConfig } from './src/lib/config'

export default defineConfig({
  title: 'Slipbox',
  description: '',
  url: 'https://example.com',   // needed for sitemap and canonical links
  author: '',

  locale: 'en',
  dir: 'ltr',                   // 'rtl' works; every rule uses logical properties

  vault: 'src/content/notes',
  layout: 'column',             // 'column' | 'panels'
  nav: 'tree',                  // 'tree' | 'tags' | 'none'

  linkResolution: 'shortest',   // 'shortest' | 'absolute' | 'relative'
  publishGate: 'all',           // 'all' | 'opt-in'
  homepage: undefined,          // slug of the note that should claim '/'
  strictLineBreaks: false,      // Obsidian's own default
  images: 'optimize',           // 'optimize' | 'passthrough'
  noIndex: false,
  transcludeDepth: 3,

  features: {
    toc: true,
    backlinks: true,
    tags: true,
    themeToggle: true,
    graph: false,               // v2
    search: false,              // v2
    hoverPreview: false,        // v2
    rss: false,                 // v2
  },

  analytics: { provider: 'none' },
  redirects: {},
})
```

A feature that is off ships **no JavaScript at all** — the island is not
rendered rather than hidden, and `npm run verify:full` asserts it.

---

## Frontmatter

Everything is optional. A vault of bare markdown with no frontmatter builds on
the first try.

```yaml
---
title: Overridden title        # else the first H1, else the filename
description: For meta tags     # else the first paragraph
aliases: [Other Name]          # resolve links, and generate redirects
tags: [method/zettelkasten]    # merged with inline #tags
created: 2026-01-02            # else git, else file mtime
updated: 2026-03-04
publish: false                 # exclude this note
draft: true                    # also excludes it
---
```

Unknown keys are left alone. Your Dataview fields will not break the build.

### What the publish gate does

By default every note is published unless it says otherwise. Set
`publishGate: 'opt-in'` if you are pointing jotter at a real vault and want
`publish: true` to be required.

An excluded note gets no page, no route, and no mention. Links to it render as
inert `<span class="dead-link">` labelled with the filename the author typed —
**never with the note's own title.** The build asserts this.

---

## Obsidian syntax support

| Syntax | Behaviour |
| --- | --- |
| `[[Note]]`, `[[Note\|Alias]]` | Resolved by shortest path, case-insensitively, through aliases |
| `[[Note#Heading]]` | Links to the heading anchor, rendered `Note > Heading` |
| `[[Note#^block]]` | Links to the note; block anchors are v1-out-of-scope |
| `![[image.png]]` | Optimized to AVIF/WebP with intrinsic dimensions |
| `![[image.png\|300]]`, `\|400x200` | A number is a **size** |
| `![[image.png\|Caption]]` | Anything else is a **caption** → `<figure>` |
| `![[Note]]`, `![[Note#Section]]` | Transcluded inline, depth-limited, cycle-guarded |
| `> [!note] Title`, `[!x]-`, `[!x]+` | Callouts, collapsible variants native `<details>` |
| `==highlight==` | `<mark>` |
| `%%comment%%` | Stripped |
| `#tag`, `#nested/tag` | Chips linking to hierarchical tag pages |
| Single newline | `<br>` unless `strictLineBreaks: true` |
| Tables, footnotes, task lists, strikethrough | GFM |

**Out of scope, deliberately:** Dataview, `.canvas`, Excalidraw, stacked notes,
comments, Mermaid, KaTeX rendering. Listed here rather than left to be
discovered.

### An authoritative link index

If `.jotter/links.json` exists at the top of your vault, it short-circuits
resolution for every link it names.

That file is meant to be written by something that could see the **whole**
vault — Obsidian itself, or a plugin — because a site generator only ever sees
the published subset and cannot reproduce attachment folders, aliases and
shortest-path matching over notes that were never published.

```json
{
  "Notes/Home.md": [
    { "raw": "Zettelkasten", "status": "published", "slug": "notes/zettelkasten" },
    { "raw": "Private Log",  "status": "unpublished" }
  ]
}
```

Links the file does not name fall back to `linkResolution`. A malformed file is
a warning, not a failed build, and an entry naming a slug this build does not
have falls back rather than emitting a link to a page that will not exist.

---

## Routes

| Route | Content |
| --- | --- |
| `/` | The note claiming it, else a generated landing page |
| `/<slug>` | A note |
| `/<folder>/` | A folder index, so tree parents are clickable |
| `/notes` | Every note, by last updated |
| `/tags`, `/tags/<a>`, `/tags/<a>/<b>` | Tag pages, parents rolling up children |
| `/404` | Offers search and recent notes |
| `/_vault/*` | Attachments Astro does not process (SVG, GIF, video, PDF) |

---

## Commands

```bash
npm run dev          # http://localhost:4321
npm run build        # astro build, then the build assertions
npm run verify       # the assertions alone, against the current dist/
npm run verify:full  # also rebuilds with features off, and at 1,000 notes
npm test             # 196 unit tests
npm run check        # astro check
npm run clean        # see the note below
```

> **If you edit anything in `src/markdown/`, run `npm run clean` first.**
> Astro caches rendered content and a markdown-plugin change does not
> invalidate that cache, so your edit will appear to do nothing.

---

## Staying up to date

"Use this template" gives you a repository with a single commit, so the first
merge from upstream needs `--allow-unrelated-histories`:

```bash
git remote add upstream https://github.com/<owner>/jotter.git
git fetch upstream
git merge upstream/main --allow-unrelated-histories
```

After that a plain `git merge upstream/main` works.

Conflicts should only land in the files you own — `jotter.config.ts`,
`src/styles/custom.css`, `src/content/notes/`, `src/i18n/`. Keep your versions
of those and take upstream's for everything else.

---

## Design

`src/styles/tokens.css` is the whole visual system: OKLCH colours, two type
scales, space, radii, durations. Light on `:root`, dark under both
`[data-theme="dark"]` and `prefers-color-scheme`.

The palette is warm throughout — neutrals on hue 60, an ochre accent on hue 70
— and the surface model is *raised*: `--surface` is lighter than `--paper`, and
anything lifted off the page carries a hairline `--rule` rather than a shadow.
There is no shadow token. `--soft`, the accent at 11% alpha, does the tinting:
nav hover, inline code, tag chips, `::selection`, link underlines.

Type runs at two scales, not one. App chrome — header, nav, labels, lists — is
`--step-ui` (16/1.65); note prose alone is `--step-body` (17/1.72). Titles are
38 (site) / 33 (note) / 29 (index) / 19 (section), with mono at 11.5 for data
(`.meta`) and 10 uppercase for section labels (`.label`).

The fastest way to re-skin jotter is to override tokens in
`src/styles/custom.css` rather than write rules:

```css
:root {
  --accent: oklch(50% 0.13 255);
  --accent-hover: oklch(40% 0.14 255);
  --soft: oklch(50% 0.13 255 / 0.11);
  --font-body: 'Your Face', serif;
  --measure: 72ch;
}
```

Every rule in the theme uses logical properties, so `dir: 'rtl'` is a config
change and not a second stylesheet. The build fails if a physical property
sneaks in.

### Accessibility

WCAG AA contrast on every token pair, in both themes, asserted at build.
Visible focus everywhere, a skip link, landmarks, `prefers-reduced-motion`,
and a print stylesheet. The navigation tree, the outline, the drawer and every
callout work with JavaScript disabled — the only script in a v1 build is the
~600-byte theme toggle and drawer enhancement.

---

## What is in v1

The reading experience, complete and entirely static: the content pipeline and
resolver, every route, both layouts, the full responsive behaviour, tokens,
type and self-hosted fonts, the markdown plugins, dead links, backlinks, the
outline, `<details>` navigation, tags, dark and light, RTL-ready i18n strings,
images, redirects, sitemap, the accessibility baseline, print CSS, the Quartz
migration guide, the demo garden, and the tests.

**v2:** search (Pagefind), the force-directed graph, hover previews, OG images,
RSS, analytics, and the Open Publish `scripts/` layer.

## License

MIT.
