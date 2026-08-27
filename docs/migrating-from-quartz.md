# Migrating from Quartz

Quartz is mature, free and well maintained. jotter is not trying to replace it
for everyone. Move if you want a site that looks composed rather than
generated, or if you have been fighting link resolution.

Stay on Quartz if you depend on its plugin ecosystem, Mermaid, KaTeX, or its
full-text search today.

---

## The one that will actually change your site

**Link resolution.** Quartz's `CrawlLinks` transformer defaults
`markdownLinkResolution` to `absolute`. Obsidian's own default is *shortest
path*. If you never changed that setting, some of your links resolved
differently on your site than in your vault — usually the ones to notes with
duplicate basenames, or written as a bare `[[Name]]` from inside a folder.

jotter defaults to `shortest`. **Your links will move.** That is the fix, but
it is a change: check any note where two files share a basename.

If you deliberately set `markdownLinkResolution: 'absolute'` in
`quartz.config.ts` and want to keep that behaviour:

```ts
// jotter.config.ts
export default defineConfig({ linkResolution: 'absolute' })
```

`relative` is also available.

---

## Mapping the config

| Quartz (`quartz.config.ts`) | jotter (`jotter.config.ts`) |
| --- | --- |
| `pageTitle` | `title` |
| `baseUrl` | `url` (with the scheme: `https://…`) |
| `locale` | `locale`, plus `dir` for RTL |
| `enableSPA` | Not applicable: every page is a real document, so there is no router to enable |
| `enablePopovers` | `features.hoverPreview`, with one visible difference — jotter embeds the excerpt at build time rather than fetching the page, so a card opens instantly and offline, and shows the first paragraph rather than the whole note |
| `analytics: { provider }` | `analytics: { provider, id }` — same providers |
| `ignorePatterns` | A note opts out with `publish: false`, or set `publishGate: 'opt-in'` |
| `defaultDateType` | `created` / `updated` are both shown; lists sort by `updated` |
| `theme.colors` | `src/styles/tokens.css`, in OKLCH |
| `theme.typography` | Astro's Fonts API in `astro.config.ts` — self-hosted, subset, no third-party request |
| `Plugin.CrawlLinks({ markdownLinkResolution })` | `linkResolution` |
| `Plugin.ObsidianFlavoredMarkdown` | Built in |
| `Plugin.SyntaxHighlighting` | Built in (Shiki, both themes) |
| `Plugin.TableOfContents` | `features.toc` |
| `quartz.layout.ts` | `layout: 'column' \| 'panels'` and `nav: 'tree' \| 'tags' \| 'none'` |
| `quartz/styles/custom.scss` | `src/styles/custom.css` (plain CSS) |

---

## What you gain

- **Dead links are inert.** An unresolved or unpublished link is a
  `<span class="dead-link">`, not an `<a href="">`. It cannot be clicked or
  focused, and it never renders an unpublished note's *title* — only the
  filename you typed.
- **A design system you can actually change.** Forty tokens, one file, WCAG AA
  asserted at build in both themes.
- **Almost no JavaScript.** A default build ships about 1.1 KB per page, and
  about 22 KB on a note page with the local graph turned on. Quartz's client
  bundle — `d3` entire, `pixi.js` and `@tweenjs/tween.js`, 107 KB before its
  graph draws anything — is a documented complaint.
- **Images optimized by default.** AVIF/WebP with intrinsic dimensions; SVG and
  GIF passed through untouched.
- **Obsidian's embed pipe rule.** `![[img.png|300]]` is a size,
  `![[img.png|A caption]]` is a caption. Quartz treats the pipe as alt text.

## What you lose

- **Search**, until v2 (Pagefind).
- **The global graph.** jotter has the *local* graph — `features.graph`, in
  the `panels` rail — but there is no whole-site graph page. The local one is
  `d3-force` on a 2D canvas rather than Pixi, and it keeps the readable list of
  neighbours underneath the picture rather than instead of it. It also names
  every node at rest — Quartz hides its labels until you zoom in — with an
  expand button that opens the same graph in a full-size dialog.
- **Mermaid, KaTeX rendering, Dataview, `.canvas`, Excalidraw.** Out of scope,
  documented rather than silently missing.
- **The plugin ecosystem.** jotter has six small markdown plugins over pure
  functions in `src/lib/`; it is not a plugin platform.

---

## Doing it

1. **Start from the template.** "Use this template" on GitHub, then
   `npm install`.

2. **Move your content.** Delete the demo garden in `src/content/notes/` and
   put your vault there. Quartz keeps content in `content/`, so:

   ```bash
   rm -rf src/content/notes/*
   cp -R ../my-quartz/content/* src/content/notes/
   ```

   Attachments can stay wherever they are inside the vault. jotter resolves
   them by filename the way Obsidian does, and serves the ones Astro does not
   process from `/_vault/`.

3. **Port the config.** Use the table above. Everything is optional, so start
   with `title` and `url` and add as you go.

4. **Port your CSS.** `custom.scss` becomes `src/styles/custom.css`, as plain
   CSS. If you were overriding Quartz colour variables, override jotter tokens
   instead:

   ```css
   :root {
     --accent: oklch(56% 0.16 25);
     --paper: oklch(98% 0.006 90);
   }
   :root[data-theme='dark'] {
     --accent: oklch(80% 0.13 25);
   }
   ```

5. **Build and read the warnings.**

   ```bash
   npm run build
   ```

   The scan reports ambiguous links naming both candidates, aliases that shadow
   a real filename, and slug collisions. These are usually pre-existing
   problems in the vault that Quartz resolved silently — worth fixing rather
   than suppressing.

6. **Keep your URLs.** If you are replacing a live Quartz site, add redirects
   for anything whose slug changed:

   ```ts
   redirects: { '/old-name': '/new-name' }
   ```

   `aliases:` in frontmatter generates redirects automatically, so an alias you
   already had is already handled.

---

## Things that will look different and are not bugs

- **Single newlines become `<br>`.** That is Obsidian's default
  (`strictLineBreaks: false`) and jotter matches it. Set
  `strictLineBreaks: true` for CommonMark behaviour.
- **A link with no alias shows the target as written.** `[[folder/Note]]`
  renders "folder/Note", and `[[Note#Heading]]` renders "Note > Heading",
  exactly as Obsidian does.
- **`index.md` inside a folder claims that folder's URL.** `notes/index.md`
  becomes `/notes`, not `/notes/index`.
- **Folders have their own pages**, so a tree parent is a link rather than a
  label that only toggles.
