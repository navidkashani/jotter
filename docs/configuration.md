# Configuration

Everything in `jotter.config.ts` is optional. A vault of bare markdown with no
config at all builds on the first try.

## The full reference

```ts
import { defineConfig } from './src/lib/config'

export default defineConfig({
  title: 'Slipbox',
  description: '',
  url: 'https://example.com',   // needed for sitemap, canonical links and RSS
  image: undefined,             // the link-preview card image, see below
  author: '',

  locale: 'en',
  dir: 'ltr',                   // the site's baseline; see docs/frontmatter.md

  vault: 'src/content/notes',
  layout: 'column',             // 'column' | 'panels'
  nav: 'tree',                  // 'tree' | 'tags' | 'none'

  linkResolution: 'shortest',   // 'shortest' | 'absolute' | 'relative'
  publishGate: 'all',           // 'all' | 'opt-in'
  homepage: undefined,          // the note that claims '/', see below
  slugs: 'derive',              // 'derive' | 'preserve' | 'obsidian'
  strictLineBreaks: false,      // Obsidian's own default
  images: 'optimize',           // 'optimize' | 'passthrough'
  noIndex: false,
  transcludeDepth: 3,

  features: {
    toc: true,
    backlinks: true,
    tags: true,
    themeToggle: true,
    metadata: false,            // the dates + frontmatter block under a title
    prevNext: true,             // links to the notes either side, in the folder
    graph: false,               // the local graph, `layout: 'panels'` only
    hoverPreview: false,        // excerpt cards on hovering a link
    search: false,              // Cmd/Ctrl+K full-text search over your notes
    rss: false,                 // /rss.xml: requires `url`
    embeds: true,               // click-to-play for video, cards for the rest
  },

  externalLinks: {
    newTab: true,               // target="_blank", plus the screen-reader warning
    icon: true,                 // the ↗ after the link text
  },

  analytics: {
    provider: 'none',        // 'plausible' | 'umami' | 'goatcounter' | 'fathom' | 'cloudflare' | 'google'
    // id: 'example.com',    // site id, domain or token: required unless 'none'
    // host: '…',            // self-hosted Plausible, Umami or GoatCounter only
  },
  redirects: {},
  folderNames: {},           // display names for folders whose path is not their name
})
```

A feature that is off ships **no JavaScript at all**. The island is not rendered
rather than hidden, and `npm run verify:full` asserts it.

`features.metadata` is off by default, matching Obsidian Publish. On, a date row
appears only where jotter has a real date: your frontmatter, or git history. It
never prints the file's mtime under the heading "Created", because on a
generated vault that is the moment of the build.

`slugs:` and `permalink:` are covered in full in
[url-styles.md](url-styles.md).

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

## The note at `/`

One note claims `/`, and it is served there and only there. It gets no second
page at its own slug, because the same note at two URLs is the same note twice
in the sitemap and twice in the search results.

The note claiming `/` is given the slug `index`, which is how jotter spells
"this note lives at the root". So every link to it resolves to `/` on its own,
in notes, cards, the nav tree, backlinks, the graph and the feed. Its previous
URL keeps working: `/<old-slug>` 302s to `/`.

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

Set none of them and the site gets a generated landing page: the most-linked
notes, and what was tended lately.

Set `homepage:` while a root `index.md` exists and config wins, as the more
deliberate statement. The `index.md` note keeps a page under a suffixed slug,
and the build prints a warning naming both files. Nothing is dropped. A
`homepage:` naming a note that is unpublished or absent falls through to the
next way of claiming it.

The redirect is a 302 rather than a 301. Unsetting `homepage:` withdraws the
rule and points it the other way, and a 301 a browser has cached is not a rule
the next build can withdraw.

## Link previews

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
so without one there is no card image at all. `image` in `jotter.config.ts`
without a `url` fails the build naming the key, the way `features.rss` does.

Set `image` in `jotter.config.ts` for a site-wide default and every page gets a
card, including `/notes`, the tag pages and the 404. A note's own `image:` beats
it. Quartz's `socialImage:` and `cover:` are read as well, so a vault that came
from there keeps the cards it had.

Use PNG, JPEG, GIF or WebP. **Not SVG**: Facebook does not render it, and a card
that cannot draw looks the same as no card while still costing a fetch. A path
naming no file in the vault, or a format no preview draws, is a build warning
naming the note and the value.

Declare nothing and the card is text only: title, description, site name.
