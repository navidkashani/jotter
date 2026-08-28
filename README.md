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
  url: 'https://example.com',   // needed for sitemap, canonical links and RSS
  image: undefined,             // the link-preview card image — see “Link previews”
  author: '',

  locale: 'en',
  dir: 'ltr',                   // the site's baseline; blocks that differ are marked per block

  vault: 'src/content/notes',
  layout: 'column',             // 'column' | 'panels'
  nav: 'tree',                  // 'tree' | 'tags' | 'none'

  linkResolution: 'shortest',   // 'shortest' | 'absolute' | 'relative'
  publishGate: 'all',           // 'all' | 'opt-in'
  homepage: undefined,          // the note that claims '/' — see “The note at /” below
  slugs: 'derive',              // 'derive' | 'preserve' | 'obsidian' — see “URLs” below
  strictLineBreaks: false,      // Obsidian's own default
  images: 'optimize',           // 'optimize' | 'passthrough'
  noIndex: false,
  transcludeDepth: 3,

  features: {
    toc: true,
    backlinks: true,
    tags: true,
    themeToggle: true,
    graph: false,               // the local graph — `layout: 'panels'` only
    hoverPreview: false,        // excerpt cards on hovering a link
    search: false,              // Cmd/Ctrl+K full-text search over your notes
    rss: false,                 // /rss.xml — requires `url`
  },

  analytics: {
    provider: 'none',        // 'plausible' | 'umami' | 'goatcounter' | 'fathom' | 'cloudflare' | 'google'
    // id: 'example.com',    // site id, domain or token, depending on the provider — required unless 'none'
    // host: '…',            // self-hosted Plausible, Umami or GoatCounter only
  },
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
status: evergreen              # these four show in the note's header block
source: Ahrens 2017
author: A. Writer
series: Reading notes
image: attachments/og.png      # the link-preview card — see “Link previews” below
publish: false                 # exclude this note
draft: true                    # also excludes it
homepage: true                 # this note claims '/' — see “The note at /” below
permalink: Company/About+us    # serve this note here instead — see “URLs” below
direction: rtl                 # this note's baseline — see “Mixed-direction vaults”
---
```

Unknown keys are left alone. Your Dataview fields will not break the build.

### What the header block shows

The boxed list at the top of a note is `created`, `updated` when it differs, and
whichever of `aliases`, `status`, `source`, `author` and `series` you set.

That list is an **allow-list**, not a deny-list. Frontmatter is whatever its
owner typed — a private URL, a note to self, a `publish: false` you forgot to
remove — so anything unrecognised stays off the page rather than leaking by
default.

`author` is display only. The name on the feed is `author` in
`jotter.config.ts`, which is a claim about who publishes the site rather than
who wrote one note.

### Spellings, and the three keys that are strict

Dates are read under five names each, so a vault written for another tool
usually needs no edits:

| jotter reads | from any of |
| --- | --- |
| created | `created`, `date`, `created_at`, `createdAt`, `published` |
| updated | `updated`, `modified`, `updated_at`, `updatedAt`, `lastmod` |

Values are taken leniently. `title: 2026` on a yearly review note is a title,
`tags: [2026, reading]` are tags, `aliases: [2026]` is an alias, and a date
jotter cannot parse falls back to git and then to the file's mtime. Nothing
there stops a build.

**`publish`, `draft` and `homepage` are the exception.** Those must be real
booleans — unquoted `true` or `false` — and anything else fails the build naming
the key. It is the one place jotter is deliberately strict, because a quoted
`publish: "false"` coerced generously is a note you meant to hide, published, in
silence. A misrouted `/` is the same mistake one key over.

### What the publish gate does

By default every note is published unless it says otherwise. Set
`publishGate: 'opt-in'` if you are pointing jotter at a real vault and want
`publish: true` to be required.

An excluded note gets no page, no route, and no mention. Links to it render as
inert `<span class="dead-link">` labelled with the filename the author typed —
**never with the note's own title.** The build asserts this over every text
file in `dist/`, not only the pages: the feed and the sitemap carry titles too,
and a check that read only HTML would have said "anywhere in `dist/`" while
reading none of them.

### Mixed-direction vaults

`dir` is the site's **baseline**, not its only direction. Every block is read at
build time, and the ones running the other way are marked:

```html
<!-- an English site (dir: 'ltr') -->
<h2>I'm Navid</h2>
<p>I'm a guy who enjoys…</p>
<p dir="rtl">اینجا محلی هست…</p>
<h3 dir="rtl">صفحات من در فضای وب</h3>
<li dir="rtl"><a>وبلاگ شخصی</a></li>
```

It is symmetric. An Arabic or Hebrew site (`dir: 'rtl'`) gets the mirror — its
own script untouched, and the *English* blocks marked `dir="ltr"` instead. The
majority language is never marked, so **a vault written in one script emits not
a single extra byte.**

The rule is Unicode's own (UBA P2/P3, the same one `dir="auto"` and Obsidian's
editor run): the first strong character in a block wins. Digits, punctuation,
symbols and emoji do not vote, so `۱۳۹۹ سال خوبی بود` and `2026 مرور سال` both
resolve right-to-left. A block with no letters in it keeps whatever it inherits.

The one case it gets wrong is a sentence opening with a word from the other
script — `Obsidian یک برنامه است` — which Obsidian gets wrong too. Set
`direction:` on that note to settle it:

```yaml
direction: rtl    # or ltr, or auto
```

Same key, same three values, as the community Obsidian RTL plugin, so a vault
that already carries it keeps working. `auto` means the default per-block
behaviour, i.e. the same as leaving it out.

> **Tip.** A note that is *entirely* Persian on an English site gets every block
> marked. Setting `direction: rtl` on that note flips its own baseline, so only
> its English blocks are marked instead — the same rendering, fewer attributes.
> Your choice; nothing is automated here.

Two limits worth knowing. Obsidian detects direction per *line* and jotter per
*block*, so a paragraph whose lines run different ways is one direction here;
`direction:` is the escape hatch. And with `features.search` on, Pagefind
indexes the whole site under `locale`, so prose in a second language is stemmed
with the wrong rules.

### Link previews

A link to a note, pasted into Slack, iMessage, WhatsApp or a tweet, unfurls as a
card. `image:` is the picture on it.

```yaml
---
image: attachments/slipbox.png       # a vault path, resolved the way an embed is
image: /og.png                       # a file in public/
image: https://cdn.example.com/x.png # somebody else's host, on purpose
---
```

It needs `url`. An unfurler has no document to resolve a relative URL against,
so without one there is no card image at all — and `image` in
`jotter.config.ts` without a `url` fails the build naming the key, the way
`features.rss` does.

Set `image` in `jotter.config.ts` for a site-wide default and every page gets a
card, including `/notes`, the tag pages and the 404. A note's own `image:` beats
it. Quartz's `socialImage:` and `cover:` are read as well, so a vault that came
from there keeps the cards it had.

PNG, JPEG, GIF or WebP. **Not SVG** — Facebook does not render it, and a card
that cannot draw is indistinguishable from no card while still costing a fetch.
A path naming no file in the vault, or a file in a format no preview draws, is a
build warning naming the note and the value; it is never silence.

Declare nothing and the card is text only — title, description, site name —
which is what every link to a jotter site was until you set one.

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
| `/pagefind/*` | The search index, with `features.search` on. Disallowed in `robots.txt` |
| `/rss.xml` | The feed, with `features.rss` on. Linked from every page |

### The note at `/`

One note claims `/`, and it is served **there and only there** — it gets no
second page at its own slug, because the same note at two URLs is the same note
twice in the sitemap and twice in the search results.

That is not a special case with links to remember. The note claiming `/` is
given the slug `index`, which is how jotter has always spelled “this note lives
at the root”, so every link to it — in a note, a card, the nav tree, backlinks,
the graph and the feed — is `/`. Its previous URL keeps working: `/<old-slug>`
301s to `/` in `_redirects` and `vercel.json`, so bookmarks and inbound links
survive the promotion.

Three ways to claim it, in this order:

```yaml
homepage: 'Zettelkasten'   # config: a slug, a vault path, or a filename
```
```yaml
---
homepage: true             # frontmatter, on the note itself
---
```
```
index.md                   # a note named index.md, in the vault root
```

Set none of them and the site gets a generated landing page — the most-linked
notes, and what was tended lately.

Set `homepage:` while a root `index.md` exists and config wins, as the more
deliberate statement: it takes `/`, the `index.md` note keeps a page under a
suffixed slug, and the build prints a warning naming both files. Nothing is
dropped. A `homepage:` naming a note that is unpublished or absent falls through
to the next way of claiming it.

### URLs you already published

By default a path becomes a slug: `Wisdom & Approaches/Critical Thinking.md` is
served at `/wisdom-approaches/critical-thinking`. That is right for a new site
and wrong for one moving onto a domain whose old addresses are already in other
people's bookmarks and in Google's index.

Two opt-in keys change it. Both leave a default build byte-for-byte unchanged.

```ts
// jotter.config.ts — the site-wide rule
slugs: 'obsidian',   // 'derive' (default) | 'preserve' | 'obsidian'
```

| `slugs:` | that note is served at |
| --- | --- |
| `'derive'` | `/wisdom-approaches/critical-thinking` |
| `'preserve'` | `/Wisdom%20&%20Approaches/Critical%20Thinking` |
| `'obsidian'` | `/Wisdom+%26+Approaches/Critical+Thinking` — byte-identical to Obsidian Publish |

```yaml
---
permalink: Company/About+us    # frontmatter — the per-note override
---
```

The note is served **there**, honoured character for character in every mode,
and its derived slug 301s to it. A list gives one page and a redirect from each
of the rest. This is the same key the Open Publish Quartz starter already writes
a note's old Obsidian URL into, so a vault it prepared needs no changes.

One caveat before you deploy: **Netlify 301s mixed-case paths to lowercase**,
with no opt-out, so `/Company/About+us` will not survive there. Cloudflare Pages,
Vercel and GitHub Pages serve them as written, and the build warns whenever it
emits a slug with an uppercase letter in it.

Full detail, including the slug/URL split and what the build asserts about it:
[`docs/url-styles.md`](docs/url-styles.md).

---

## Commands

```bash
npm run dev          # http://localhost:4321
npm run build        # astro build, then the build assertions
npm run verify       # the assertions alone, against the current dist/
npm run verify:full  # also rebuilds with features off, analytics on, RSS on, a homepage set, and at 1,000 notes
npm test             # 309 unit tests
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
sneaks in — and because the CSS is logical throughout, a block that runs the
other way flips its alignment, indents, list markers and quote bars for free.
See “Mixed-direction vaults”.

### Accessibility

WCAG AA contrast on every token pair, in both themes, asserted at build.
Visible focus everywhere, a skip link, landmarks, `prefers-reduced-motion`,
and a print stylesheet. The navigation tree, the outline, the drawer and every
callout work with JavaScript disabled — the only scripts in a default build
are the theme island and the drawer enhancement, about 1.1 KB together. Turn
`features.graph` on and a note page adds an 18 KB `d3-force` chunk, about
22 KB in all; the graph's own accessible list stays underneath it either way.
`features.hoverPreview` adds about 1.2 KB and no request at all, plus the
excerpts themselves in the markup — 1 KB raw and under 200 bytes brotli'd on
the demo's most-linked page. `features.search` adds about 6 KB, on every page
rather than only note pages, and nothing else until a reader actually opens it:
the modal is keyboard-first, focus is trapped and returned, results are real
links, and the count is announced. With scripting off there is no search button
at all, because one that did nothing would be worse than none.

The per-page budget is asserted at 32 KB of jotter's own JavaScript. It was
24 KB until search shipped; graph and search together measure 29,334 bytes on a
note page, so the ceiling moved once, deliberately, and
`scripts/verify-build.mjs` says why. A configured analytics provider's script is
not counted against it — it is not a file in `dist/`, and its weight is the
vendor's rather than jotter's — but the build reports the tag and its origin
next to the number, so the exclusion is visible rather than silent.

---

## What is in v1

The reading experience, complete and entirely static: the content pipeline and
resolver, every route, both layouts, the full responsive behaviour, tokens,
type and self-hosted fonts, the markdown plugins, dead links, backlinks, the
outline, `<details>` navigation, tags, dark and light, RTL-ready i18n strings,
images, redirects, sitemap, the accessibility baseline, print CSS, the Quartz
migration guide, the demo garden, and the tests.

**Since v1:** the local graph — a `d3-force` layout on a canvas in the
`panels` rail, off by default, with the readable list of neighbours kept
underneath it for keyboards, screen readers and scripting-off. Every node is
named; the rail card elides long titles to its width and an expand button
opens the same graph in a dialog where nothing is elided.

And hover previews, also off by default: hold the pointer over a link and a
small card shows the target's title and opening paragraph, so you can decide
whether to follow it without leaving the paragraph you are in. Quartz and
Obsidian Publish both *fetch* the target; jotter does not, because the build
fails on `fetch(` anywhere in jotter's own code. So the excerpt travels in the
HTML instead — instant, offline, and the first paragraph rather than the whole
note. Pointer only, and the card is `aria-hidden`: it repeats what the
destination already says, one click away.

And **search**, off by default too: `features.search` puts a magnifier in the
header and binds Cmd/Ctrl+K on every page, over the notes only. Pagefind builds
the index at the end of `astro build`; the runtime is fetched on first open
rather than on page load, so a reader who never searches downloads none of it.
Results carry the matching section's anchor, so a hit inside a long note jumps
to the heading rather than the top.

And **analytics**, off by default, and the only switch in jotter that adds a
request to somebody else's server. `analytics.provider` takes `plausible`,
`umami`, `goatcounter`, `fathom`, `cloudflare` or `google`, and jotter emits
that vendor's own documented tag and nothing else — no wrapper, no consent
banner, no Do-Not-Track branch. Quartz builds the same six from JavaScript and
rewires each into manual pageview mode because it is an SPA and the document
never reloads; jotter is not, so a real navigation fires the vendor's own
automatic pageview, correctly, for free. There is nothing to port.

Nothing ships during `astro dev`, which is deliberate: without that gate every
local reload would be a real pageview against real production stats. Use
`astro preview` to check your own setup.

There is deliberately no `custom` provider. A field taking an arbitrary script
URL is one the origin assertion below cannot check, and an assertion with a hole
shaped like "anything the user typed" is not an assertion. Six providers, six
known origins — or none, which is the default. If you need something else, paste
its snippet into `src/layouts/Base.astro`.

And **RSS**, off by default and the last v1 flag the build did not honour.
`features.rss: true` writes `/rss.xml` at the end of `astro build` and links it
from the `<head>` of every page, which is how a browser and every reader find
it. It needs `url` — a feed's links are resolved against nothing, so a relative
one is not a degraded link but an unfollowable one, and the config refuses the
pair rather than shipping a feed nobody can use.

Items carry the note's title, its excerpt, its tags as `<category>`, and both of
its dates. That last part is worth stating rather than leaving to be
discovered: **a revised note updates in place, it does not resurface.** Readers
dedupe on `<guid>`, and RSS Guard stopped re-marking updated items unread in
4.6.4 — FreshRSS behaves the same. So `<pubDate>` is the note's *created* date
and never moves, because moving it would reshuffle a subscriber's list for
nothing; the revision time goes in `<atom:updated>`, which is the element that
means that. Two consecutive builds of an unchanged vault produce a
byte-identical file.

The window is the 50 most recently updated notes, a constant rather than a
config key. Ten — Quartz's default — is too few once you notice that a
revision re-enters the window: a weekend of tidying old notes can push a new one
out before a fortnightly subscriber ever polls, and because of the guid rule
above they will never be shown it. Fifty is wide enough that it cannot happen
and still a few KB at any vault size. A feed is a change notification; `/notes`
is the archive, one click from every item.

The feed carries excerpts rather than full HTML — Quartz's default agrees — and
escapes every value rather than wrapping it in CDATA, which closes the `]]>`
hole a CDATA section has by construction. There is no XSLT stylesheet: it is
the usual way to make a feed readable in a browser and it is dying, with
Chrome's XSLT removal announced for November 2026 and Firefox and WebKit
signalling the same. And there is no JSON Feed, which is still published
*alongside* RSS rather than instead of it, so it would be a second surface to
keep correct for readers that already accept the first.

One thing jotter cannot do from the build: **set the Content-Type**. Netlify and
Vercel both serve `.xml` as `application/xml` by default and every reader
accepts that, but misconfigured hosts are reported in the wild. If a reader
refuses your feed, check the header your host is actually sending.

`noIndex: true` does not suppress the feed. `noIndex` is about crawlers, and a
subscription is something you opted into twice — the flag and a `url`.

### What "no network" means now

It used to mean *nothing jotter ships reaches the network*. Search ended that
first — Pagefind loads index chunks over plain GETs as you type, which is the
entire reason a thousand-note vault is searchable without shipping one enormous
file — and analytics ends it a second time, on purpose and only if you ask.
Each bullet below is true on its own; none of them is retracted by the next.

- **No tracking unless you configure it.** `analytics.provider` defaults to
  `'none'`, and a default build emits no analytics tag at all — not a disabled
  one, not an empty one, none. Set it and the vendor's code is on your site from
  that moment, and the bullet below stops describing it.
- **No third-party origin you did not ask for.** No CDN, no fonts from someone
  else's server — those are self-hosted and subset. `scripts/verify-build.mjs`
  collects every external `src` and `href` in `dist/` and fails unless each one
  is a tag jotter itself emitted and marked, and unless the whole site talks to
  at most one origin that is not its own. An origin nobody asked for fails the
  build; so does a second tracker riding along beside the first.
- **No server.** Every page is a static file. Search runs in the reader's
  browser against files on your own origin, so a query never leaves it, and
  turning search off leaves nothing behind: no index directory, and no markup
  marked up for one.
- **The code jotter wrote makes no requests at all.** The build still fails on
  `fetch(`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` or `EventSource` in any
  inline block or bundled chunk. The exemption is `dist/pagefind/**`, by path,
  and nothing else — which is what keeps hover previews embedded rather than
  fetched. It does not read a configured vendor's script, because that script is
  not jotter's and is not in `dist/`. What jotter asserts about analytics is
  which origin the tag points at, not what the vendor does once it is running.
  Nobody can assert the second; saying so is better than implying otherwise.

Two things jotter cannot detect, and does not pretend to. A site proxied through
Cloudflare with Web Analytics enabled at the dashboard already has the beacon
injected, so configuring `cloudflare` here counts twice. And a Netlify or Vercel
preview deploy is a production build, so the tag ships there too — Plausible and
Fathom simply will not count a domain you have not registered, and GA4 will.

**Still to come:** *generated* OG images — a card drawn from the note's own
title and description for the notes that declare no `image:` — and the Open
Publish `scripts/` layer. Declared ones work today; see “Link previews”.

## License

MIT.
