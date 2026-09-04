# jotter

An Astro theme for publishing an Obsidian vault, designed rather than merely
generated. Point it at a folder of markdown and it works. The whole visual
system is about forty CSS custom properties in one file, so changing the accent
changes the site.

## Quick start

```bash
# Use this template on GitHub, then:
npm install
npm run dev
```

Point `vault:` in `jotter.config.ts` at your own notes, as a folder, a symlink
or a git submodule. Leave the demo garden where it is: nothing outside your
vault folder is built, and deleting a file jotter ships is the one change that
conflicts with every future update.

## What you get

- **Links that resolve exactly like Obsidian.** Shortest-path matching by
  default, through aliases, case-insensitively.
- **A dead link is never a live link.** A link to an unpublished or missing note
  renders as inert text labelled with the filename the author typed, never with
  the target note's title.
- **One token file for the whole theme.** No Tailwind, no SCSS, no second
  styling idiom for prose. The build fails on a colour literal anywhere else.
- **Wikilinks parsed by the markdown engine**, not by a regex over your prose,
  so a `[[link]]` inside a code fence survives untouched.
- **Obsidian's syntax**, including callouts, transclusions, the embed pipe rule,
  highlights, nested tags and footnotes.
- **Images optimized by default** to AVIF and WebP, with intrinsic dimensions.
- **Optional search, local graph, hover previews, RSS and analytics.** Each is
  off by default, and a feature that is off ships no JavaScript at all.
- **The URLs you already published.** `slugs: 'obsidian'` reproduces Obsidian
  Publish's own addresses, and `permalink:` overrides one note.

## What you own

**jotter never writes to any of these**, which is what makes an update a merge
rather than an argument. Everything else is upstream and merges cleanly.

| Path | What it is |
| --- | --- |
| `jotter.config.ts` | Site settings. Every field optional. |
| `src/styles/custom.css` | Your CSS. Loads last. Override tokens, not rules. |
| `src/user/*.astro` | Your own Header, Sidebar, Head, Footer, Frontmatter, PrevNext. |
| `src/i18n/*.json` | Your translations. Dropping the file in is the whole procedure. |
| your vault folder | Wherever `vault:` points. |

Each is a file you *add*, not a file you edit, so upstream has no copy of it to
disagree with. Customising by editing `src/layouts/Base.astro` conflicts with
every release that touches `Base.astro`; the same change as
`src/user/Head.astro` conflicts with nothing. See
[src/user/README.md](src/user/README.md) for the slots and their props.

## Staying up to date

**Actions → Update theme → Run workflow.** Your repository ships that workflow.
It merges jotter onto a branch inside your own repository and gives you a pull
request to review, and it never writes to your default branch. Which jotter your
site runs is reported to Obsidian on every publish. See
[docs/updating.md](docs/updating.md).

## Privacy

- **No tracking unless you configure it.** `analytics.provider` defaults to
  `'none'`, and a default build emits no analytics tag at all: not a disabled
  one, not an empty one, none.
- **No third-party origin you did not ask for.** No CDN, and no fonts from
  somebody else's server. `scripts/verify-build.mjs` collects every external
  `src` and `href` in `dist/` and fails unless each one is a tag jotter itself
  emitted and marked.
- **No server.** Every page is a static file. Search runs in the reader's
  browser against files on your own origin, so a query never leaves it.
- **The code jotter wrote makes no requests.** The build fails on `fetch(`,
  `XMLHttpRequest`, `WebSocket`, `sendBeacon` or `EventSource` in any inline
  block or bundled chunk, with `dist/pagefind/**` exempted by path.

Two things jotter cannot detect, and does not pretend to. A site proxied through
Cloudflare with Web Analytics enabled at the dashboard already has the beacon
injected, so configuring `cloudflare` here counts twice. And a Netlify or Vercel
preview deploy is a production build, so a configured tag ships there too.

## Commands

```bash
npm run dev          # http://localhost:4321
npm run build        # fetch (if configured), astro build, the assertions, finalize
npm run verify       # the assertions alone, against the current dist/
npm run verify:full  # and jotter's own maintenance suite
npm test             # the unit tests
npm run check        # astro check
npm run clean        # dist/, the Astro caches, and .jotter/
```

`verify` reads `dist/` and nothing else, which is what makes it safe inside
`npm run build` on your site. It prints three kinds of line, and only `FAIL`
stops a build. See
[open-publish.md](docs/open-publish.md#two-kinds-of-verify-failure).

> **If you edit anything in `src/markdown/`, run `npm run clean` first.** Astro
> caches rendered content and a markdown-plugin change does not invalidate that
> cache, so your edit will appear to do nothing.

## Guides

| Guide | What it covers |
| --- | --- |
| [Configuration](docs/configuration.md) | Every config key, the routes, and the note at `/`. |
| [Frontmatter](docs/frontmatter.md) | Every key a note can carry, and mixed-direction vaults. |
| [Obsidian syntax](docs/markdown.md) | What jotter renders, and what it deliberately does not. |
| [URL styles](docs/url-styles.md) | Keeping the addresses you already published. |
| [Design and theming](docs/theming.md) | Tokens, re-skinning, and the accessibility baseline. |
| [Open Publish](docs/open-publish.md) | Building straight from an Obsidian snapshot. |
| [Updating](docs/updating.md) | Taking a new version of the theme. |
| [Migrating from Quartz](docs/migrating-from-quartz.md) | The config mapping, and what changes. |

What changed in each release is in [CHANGELOG.md](CHANGELOG.md).

## Licence

MIT.
