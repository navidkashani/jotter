# Migrating from Quartz

Quartz is mature, free and well maintained. jotter is not trying to replace it
for everyone. Move if you want a site that looks composed rather than generated,
or if you have been fighting link resolution. Stay on Quartz if you depend on
its plugin ecosystem, Mermaid, or KaTeX.

## Three things jotter does differently

**Links resolve exactly like Obsidian.** Quartz's `CrawlLinks` transformer
defaults `markdownLinkResolution` to `absolute`, and Obsidian's own default is
*shortest path*. If you never changed that setting, some of your links resolved
differently on your site than in your vault, usually the ones to notes with
duplicate basenames or written as a bare `[[Name]]` from inside a folder.

**The whole theme is one token file.** No Tailwind, no SCSS, no second styling
idiom for prose. `src/styles/tokens.css` holds every colour, space, type step,
radius and duration, and the build fails on a colour literal anywhere else.

**Wikilinks are parsed by the markdown engine, not by a regex over your prose.**
Quartz hand-rolls `[[…]]` detection. jotter's engine parses it natively, which
is why a `[[link]]` inside a code fence survives untouched.

## The one that will actually change your site

jotter defaults to `shortest`, so **your links will move.** That is the fix, and
it is still a change: check any note where two files share a basename.

To keep Quartz's behaviour instead:

```ts
// jotter.config.ts
export default defineConfig({ linkResolution: 'absolute' })
```

`relative` is also available.

## Mapping the config

| Quartz (`quartz.config.ts`) | jotter (`jotter.config.ts`) |
| --- | --- |
| `pageTitle` | `title` |
| `baseUrl` | `url` (with the scheme: `https://…`) |
| `locale` | `locale`, plus `dir` for RTL |
| `enableSPA` | Not applicable: every page is a real document. This is also why none of Quartz's analytics machinery ports across. Quartz fires pageviews manually on a custom `nav` event, because in an SPA the document never reloads; jotter emits each vendor's plain documented tag and a real navigation does the rest |
| `enablePopovers` | `features.hoverPreview`. jotter embeds the excerpt at build time rather than fetching the page, so a card opens instantly and offline, and shows the first paragraph rather than the whole note |
| `analytics: { provider: 'google', tagId }` | `analytics: { provider: 'google', id: tagId }` |
| `analytics: { provider: 'plausible', host? }` | `analytics: { provider: 'plausible', id: '<your domain>', host? }`: jotter needs the domain named, and its build asserts the id reached the markup. Quartz reads it from `location.hostname` at runtime |
| `analytics: { provider: 'umami', host, websiteId }` | `analytics: { provider: 'umami', id: websiteId, host? }`. jotter's default host is `cloud.umami.is`; Quartz still ships `analytics.umami.is` |
| `analytics: { provider: 'goatcounter', websiteId, host?, scriptSrc? }` | `analytics: { provider: 'goatcounter', id: websiteId, host? }`: jotter's `host` is the whole endpoint, where Quartz's is a domain suffix. No `scriptSrc` equivalent |
| `posthog`, `tinylytics`, `cabin`, `clarity`, `matomo`, `vercel`, `rybbit` | **No equivalent.** jotter supports six providers; `fathom` and `cloudflare` are additions Quartz does not have |
| `ignorePatterns` | A note opts out with `publish: false`, or set `publishGate: 'opt-in'` |
| `defaultDateType` | `created` / `updated` are both shown; lists sort by `updated` |
| `theme.colors` | `src/styles/tokens.css`, in OKLCH |
| `theme.typography` | Astro's Fonts API in `astro.config.ts`: self-hosted, subset, no third-party request |
| `Plugin.CrawlLinks({ markdownLinkResolution })` | `linkResolution` |
| `Plugin.ObsidianFlavoredMarkdown` | Built in |
| `Plugin.SyntaxHighlighting` | Built in (Shiki, both themes) |
| `Plugin.TableOfContents` | `features.toc` |
| `Plugin.ContentIndex` and the search component | `features.search`: Pagefind builds the index at the end of `astro build`, and jotter draws the modal in its own tokens |
| `Plugin.ContentIndex({ enableRSS: true })` | `features.rss`, plus `url`: jotter refuses the flag without one, because a feed's links resolve against nothing. The feed is `/rss.xml`, not Quartz's `/index.xml`; keep your subscribers with `redirects: { '/index.xml': '/rss.xml' }` |
| `rssFullHtml` | **No equivalent.** The excerpt only, which is Quartz's own default. Full HTML would mean rewriting every wikilink, image and transclusion to an absolute URL |
| `rssLimit` | **No equivalent.** Fixed at 50. A revision re-enters the window, so at Quartz's default of 10 a weekend of tidying can evict a new note before a subscriber polls, and readers dedupe on `guid`, so they never see it |
| `rssSlug` | **No equivalent.** Fixed at `rss.xml` |
| `socialImage`, `image` or `cover` in frontmatter | `image:`. All three spellings are read and `image` wins. Plus `image` in `jotter.config.ts` for a site-wide default a note can override. Needs `url`, and PNG/JPEG/GIF/WebP. See [configuration.md](configuration.md#link-previews) |
| `permalink` in frontmatter | `permalink:`, **and it changes meaning.** On Quartz it emits a `noindex` meta-refresh bounce page and the note stays at its derived slug. On jotter the note is *served* there, and the derived slug 302s to it. The same URLs work either way; the canonical one moves. jotter also accepts a list. See [url-styles.md](url-styles.md) |
| `Plugin.CustomOgImages` | **Not yet.** Quartz generates a card from each page's title and description; jotter emits the one you declare and nothing where you declare none |
| `quartz.layout.ts` | `layout: 'column' \| 'panels'` and `nav: 'tree' \| 'tags' \| 'none'` |
| `quartz/styles/custom.scss` | `src/styles/custom.css` (plain CSS) |

## What you gain

- **Dead links are inert.** An unresolved or unpublished link is a
  `<span class="dead-link">`, not an `<a href="">`. It cannot be clicked or
  focused, and it shows the filename you typed rather than the target's title.
- **A design system you can actually change.** Forty tokens, one file, WCAG AA
  asserted at build in both themes.
- **Almost no JavaScript.** About 1.1 KB per page by default, about 22 KB with
  the local graph on, and about 29 KB with graph and search both on. Quartz
  ships 107 KB before its graph draws anything.
- **Images optimized by default.** AVIF and WebP with intrinsic dimensions, and
  SVG and GIF passed through untouched.
- **Obsidian's embed pipe rule.** `![[img.png|300]]` is a size and
  `![[img.png|A caption]]` is a caption. Quartz treats the pipe as alt text.
- **A feed that validates.** Quartz's is missing `<atom:link rel="self">`,
  `<language>`, `<lastBuildDate>` and an explicit `isPermaLink`, hardcodes
  `https://`, and wraps note text in CDATA with no `]]>` guard. jotter escapes
  instead, and the build asserts the rest.
- **Search over your notes and nothing else.** Quartz indexes every emitted
  page, so a hit can land on a tag listing that merely mentions what you wanted.

## What you lose

- **The global graph.** jotter has the local graph (`features.graph`, in the
  `panels` rail) but no whole-site graph page.
- **Mermaid, KaTeX rendering, Dataview, `.canvas`, Excalidraw.** Out of scope.
- **The plugin ecosystem.** jotter has six small markdown plugins over pure
  functions in `src/lib/`. It is not a plugin platform.

## Doing it

1. **Start from the template.** "Use this template" on GitHub, then
   `npm install`.

2. **Move your content.** Put your vault in a folder of its own and point
   `vault:` at it. Quartz keeps content in `content/`, so:

   ```bash
   cp -R ../my-quartz/content ./notes
   ```

   ```ts
   // jotter.config.ts
   vault: 'notes',
   ```

   Leave the demo garden in `src/content/notes/` where it is. Nothing outside
   your vault folder is built, and deleting a file jotter ships is a
   modify/delete conflict on every future update. See [updating.md](updating.md).

   Attachments can stay wherever they are inside the vault. jotter resolves them
   by filename the way Obsidian does, and serves the ones Astro does not process
   from `/_vault/`.

3. **Port the config.** Use the table above. Everything is optional, so start
   with `title` and `url` and add as you go.

4. **Port your CSS.** `custom.scss` becomes `src/styles/custom.css`, as plain
   CSS. If you were overriding Quartz colour variables, override jotter tokens
   instead. See [theming.md](theming.md):

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
   problems in the vault that Quartz resolved silently: worth fixing rather
   than suppressing.

6. **Keep your URLs.** If you are replacing a live Quartz site, add redirects
   for anything whose slug changed:

   ```ts
   redirects: { '/old-name': '/new-name' }
   ```

   `aliases:` in frontmatter generates redirects automatically, so an alias you
   already had is already handled.

   If the addresses you are keeping are Obsidian Publish's rather than
   Quartz's (because that is where the vault was before Quartz) `slugs:` does
   the whole set at once rather than one redirect at a time, and `permalink:`
   overrides a single note. See [url-styles.md](url-styles.md).

## Things that will look different and are not bugs

- **Single newlines become `<br>`.** That is Obsidian's default
  (`strictLineBreaks: false`) and jotter matches it. Set
  `strictLineBreaks: true` for CommonMark behaviour.
- **A link with no alias shows the target as written.** `[[folder/Note]]`
  renders "folder/Note", and `[[Note#Heading]]` renders "Note > Heading",
  exactly as Obsidian does.
- **`index.md` inside a folder claims that folder's URL.** `notes/index.md`
  becomes `/notes`, not `/notes/index`.
- **A `permalink:` note is served at its permalink**, rather than bouncing to it
  from a `noindex` page. Both URLs work; the canonical one is the permalink. See
  the table above.
- **Folders have their own pages**, so a tree parent is a link rather than a
  label that only toggles.
