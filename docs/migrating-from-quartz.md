# Migrating from Quartz

Quartz is mature, free and well maintained. jotter is not trying to replace it
for everyone. Move if you want a site that looks composed rather than
generated, or if you have been fighting link resolution.

Stay on Quartz if you depend on its plugin ecosystem, Mermaid, or KaTeX.

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
| `enableSPA` | Not applicable: every page is a real document, so there is no router to enable. This is also why none of Quartz's analytics machinery ports across — it fires pageviews *manually*, on a custom `nav` event, because in an SPA the document never reloads and the vendor's automatic pageview fires once and never again. jotter emits each vendor's plain documented tag and a real navigation does the rest. Nothing to port, and nothing missing |
| `enablePopovers` | `features.hoverPreview`, with one visible difference — jotter embeds the excerpt at build time rather than fetching the page, so a card opens instantly and offline, and shows the first paragraph rather than the whole note |
| `analytics: { provider: 'google', tagId }` | `analytics: { provider: 'google', id: tagId }` |
| `analytics: { provider: 'plausible', host? }` | `analytics: { provider: 'plausible', id: '<your domain>', host? }` — jotter needs the domain named. Quartz reads it from `location.hostname` at runtime, which cannot mismatch but also means the tag no longer says what it tracks; jotter's build asserts the id reached the markup instead |
| `analytics: { provider: 'umami', host, websiteId }` | `analytics: { provider: 'umami', id: websiteId, host? }` — and note jotter's default host is `cloud.umami.is`, the current one. Quartz still ships `analytics.umami.is` |
| `analytics: { provider: 'goatcounter', websiteId, host?, scriptSrc? }` | `analytics: { provider: 'goatcounter', id: websiteId, host? }` — jotter's `host` is the whole endpoint (`https://stats.example.com`), where Quartz's is the domain suffix it interpolates the site code into. There is no `scriptSrc` equivalent |
| `posthog`, `tinylytics`, `cabin`, `clarity`, `matomo`, `vercel`, `rybbit` | **No equivalent.** jotter supports six providers; `fathom` and `cloudflare` are additions Quartz does not have |
| `ignorePatterns` | A note opts out with `publish: false`, or set `publishGate: 'opt-in'` |
| `defaultDateType` | `created` / `updated` are both shown; lists sort by `updated` |
| `theme.colors` | `src/styles/tokens.css`, in OKLCH |
| `theme.typography` | Astro's Fonts API in `astro.config.ts` — self-hosted, subset, no third-party request |
| `Plugin.CrawlLinks({ markdownLinkResolution })` | `linkResolution` |
| `Plugin.ObsidianFlavoredMarkdown` | Built in |
| `Plugin.SyntaxHighlighting` | Built in (Shiki, both themes) |
| `Plugin.TableOfContents` | `features.toc` |
| `Plugin.ContentIndex` and the search component | `features.search` — Pagefind builds the index at the end of `astro build`, and jotter draws the modal in its own tokens rather than using Pagefind's web components |
| `Plugin.ContentIndex({ enableRSS: true })` | `features.rss`, plus `url` — jotter refuses the flag without one, because a feed's links resolve against nothing. The feed is `/rss.xml`, not Quartz's `/index.xml`; keep your existing subscribers with `redirects: { '/index.xml': '/rss.xml' }`, which jotter writes into both `_redirects` and `vercel.json` |
| `rssFullHtml` | **No equivalent.** The excerpt only, which is Quartz's own default. Full HTML would mean rewriting every wikilink, image and transclusion to an absolute URL, and that is the layer Open Publish exists to be |
| `rssLimit` | **No equivalent.** Fixed at 50. Quartz's default of 10 is too few once you notice that a *revision* re-enters the window, so a weekend of tidying can evict a new note before a subscriber polls — and readers dedupe on `guid`, so they never see it |
| `rssSlug` | **No equivalent.** Fixed at `rss.xml` |
| `socialImage`, `image` or `cover` in frontmatter | `image:` — all three spellings are read, `image` wins, and the file is resolved against the vault the way an embed is. Plus `image` in `jotter.config.ts` for a site-wide default a note can override. Needs `url`, and PNG/JPEG/GIF/WebP: an SVG card is one Facebook will not draw, so it is a build warning rather than a tag |
| `Plugin.CustomOgImages` | **Not yet.** Quartz's emitter *generates* a card from each page's title and description; jotter emits the one you declare and nothing where you declare none. Generated images are the half still to come |
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
- **Almost no JavaScript.** A default build ships about 1.1 KB per page, about
  22 KB on a note page with the local graph turned on, and about 29 KB with the
  graph and search both on. Quartz's client bundle — `d3` entire, `pixi.js` and
  `@tweenjs/tween.js`, 107 KB before its graph draws anything — is a documented
  complaint. Pagefind's runtime is fetched when a reader opens the modal, not
  when the page loads, so a visit that never searches pays none of it.
- **Images optimized by default.** AVIF/WebP with intrinsic dimensions; SVG and
  GIF passed through untouched.
- **Obsidian's embed pipe rule.** `![[img.png|300]]` is a size,
  `![[img.png|A caption]]` is a caption. Quartz treats the pipe as alt text.
- **A feed that validates.** Quartz's is missing `<atom:link rel="self">` and
  the namespace it needs, `<language>`, `<lastBuildDate>` and an explicit
  `isPermaLink`; it hardcodes `https://` rather than using the URL you
  configured; and it wraps note text in CDATA with no `]]>` guard, so a note
  containing that sequence corrupts the document. jotter escapes instead, which
  has no such hole to forget, and the build asserts the rest.
- **Search that indexes your notes and nothing else.** Quartz's
  `ContentIndex` indexes every emitted page, so a hit can land on a tag listing
  that merely mentions the note you wanted. jotter marks only note pages as
  indexable, and cuts the breadcrumb, the dates and the prev/next links back
  out — so an excerpt opens with the note's own prose rather than with its file
  path and its modification date.

## What you lose

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
