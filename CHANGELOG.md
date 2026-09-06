# Changelog

The version a site is running is reported to Obsidian on every publish, in
`dist/_publish.json`, so "which jotter is this" has an answer without anybody
opening a terminal. See [docs/updating.md](docs/updating.md).

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the versions are [semantic](https://semver.org/): a bump of the leading number
is a change that can break a site on update — a config key removed, a
component's props changed, markup a `custom.css` was written against.

jotter is pre-1.0, so for now that leading number is the **minor**: `0.8.0` is
where a breaking change goes, and `0.7.x` is safe to take. The config API is
still moving (`astro.config.ts` changed in 17 of the last 48 commits), and
saying so in the version number is more honest than a 1.0 that would not hold.

## [0.8.0] - 2026-09-06

Direction, checked at the level it is actually decided — plus the seven commits
that had accumulated since `0.7.2`.

`0.7.0` learned to detect direction per block and mark the blocks running
against the page. What it did not do was tell the rest of the theme that the
block level existed: the CSS, the two islands built in the browser and the
chrome components all still reasoned about `<html dir>` alone. This closes that,
and makes the claim in [docs/theming.md](docs/theming.md) true rather than
aspirational.

**A minor bump, because four things changed shape.** jotter is pre-1.0, so the
minor is where a breaking change goes. Read the four below; if none of them
describes your site — and for most they will not — this is safe to take.

### Breaking

- **A note or folder that slugs to `notes` now keeps `/notes`, and the
  "All notes" listing moves to `/all-notes`.** The listing used to win that collision, so
  the folder had no page at all and two chrome links pointed at the listing.
  The address belongs to something somebody wrote, and the listing is the one
  thing in the collision that can move. **If you link to `/notes` meaning the
  listing, update it**; jotter's own chrome now builds that URL through
  `allNotesHref` and follows the move on its own. A vault with nothing claiming
  that slug is unaffected and keeps `/notes`.
- **The prose list indent moved from the list to the item.**
  `.prose :is(ul, ol)` no longer sets `padding-inline-start: 21px`; `.prose li`
  sets `margin-inline-start: 21px` instead. A `custom.css` that retuned list
  indentation by overriding the list's padding now changes nothing — override
  `.prose li { margin-inline-start: … }`. The task-list rule changed with it,
  from `margin-inline-start: -21px` to `margin-inline-start: 0`.
- **The video play triangle is a `clip-path`, not border triangles.** Anything
  restyling `.video-embed-play::before` through `border-inline-start` or
  `border-block` now styles nothing.
- **The breadcrumb no longer ends with the note's own title.** It printed the
  title one line above the `<h1>` printing the same string, and on an Open
  Publish build — where every note is written to its slug — it could say the
  same words three times. A `custom.css` targeting the last crumb should expect
  one fewer element.

### Fixed

- **A list marker could hang outside the page on mobile.** `list-style: revert`
  means an outside marker is laid against its *own item's* edge, so an
  `li[dir="rtl"]` inside an unmarked `<ul>` drew its bullet past the list's right
  edge, where the gutter is zero, while the 21px sat empty on the left. `.main`
  absorbs it at desk widths; on mobile that padding drops to 16px, nothing clips
  it, and a wide `<ol>` marker pushed the page sideways. Measured in Chrome 151,
  Firefox 153 and WebKit 26.6: an outside marker is held by item *margin* and not
  by item padding, which is why the gutter moved rather than being duplicated.
- **A block running the other way was not aligned in Firefox or Safari.** Both
  ship `li { text-align: match-parent }` in their UA stylesheets, and
  `match-parent` resolves `start` against the *parent list's* direction, so a
  Persian item inside an English list computed to `text-align: left` and stayed
  pinned to the wrong edge whatever its marker did. Chrome does not do this, so
  it survived a Chrome-only look.
- **Hover previews ignored the direction of the note they were showing.** The
  card is appended to `<body>`, so the only direction it could inherit was the
  site's. The text is known at build time, so it now travels with it, on two new
  `data-preview-*-dir` attributes emitted only when they differ from the page.
- **A ` > ` in a preview title reordered between two runs that disagreed**, so
  `Note > Heading` could read `Heading < Note`. Each half is isolated now, and
  only when they disagree.
- **`[dir='rtl'] …` rules inside `.prose` could never match a marked block.** An
  ancestor attribute selector only ever matches `<html dir>`, so a Persian
  transclusion on an English site drew its arrow pointing back into its own
  text. Rules inside `.prose` use `:dir()` now, which matches a resolved
  direction. `.nav-tree` and `.sidebar` keep the attribute form: they are chrome
  and can only ever take the site's direction.
- **The video play triangle mirrored**, against its own comment and against
  every guideline on media controls, which track playback rather than text.
- **Canvas graph labels were drawn left-to-right whatever they said.** The
  payload carries a direction now and the canvas sets `ctx.direction` before
  drawing, which also fixes elision: `…` is neutral, and in a forced
  left-to-right context it landed at the *start* of a right-to-left label.
- **The search field had no direction**, so a Persian query typed into a
  left-aligned box with the caret and punctuation on the wrong side.
- **Sorting ignored numbers.** `Note 10` sorted before `Note 2`. Display sorts
  now use `Intl.Collator` with `numeric` and the site's locale. Link resolution
  deliberately still does not: which note a wikilink finds must not depend on a
  display setting.
- **A printed link's URL reordered** against right-to-left text around it.
- **A callout title that was a link was deleted outright.**
  `> [!info] [Title](https://…)` rendered as the bare word `Info` with the URL
  nowhere on the page. Any title that was not one uninterrupted text node hit
  this: `**bold**`, `code`, a `[[wikilink]]`, or a link with words either side.
- **A note opening with a callout described itself by its marker.**
  `> [!NOTE] …` became `[!NOTE] …` in the note card, the hover preview, the
  search result, `<meta name="description">` and `og:description` — so the
  marker was what search engines and social cards had to show.
- **Two Open Publish site options were unreachable.** `showHoverPreview` and
  `showInlineTitle` are honoured now. **Open Publish sites will gain link
  previews on their next build**, and the island's JavaScript with them: the
  flag defaulted off and was never emitted, so those sites had previews off
  while the Publish site they migrated from had them on.

### Added

- **Alignment for titles in the chrome.** Card titles, list rows, backlinks,
  prev/next, the TOC, the nav tree, the breadcrumb, tag chips and the graph's
  link list now carry a `dir` where the text runs the other way.
  `unicode-bidi: isolate` kept their runs in order and could never move them to
  the correct edge of the box; this is the half that was missing.
- **Search results get `unicode-bidi: plaintext`.** A Pagefind excerpt is
  assembled in the browser and has no build-time answer to emit, so the browser
  runs the same first-strong rule per paragraph.
- **Arabic and Persian typography.** `letter-spacing` pulls apart the joins of a
  cursive script, which is what `--tracking-label: 0.1em` was doing at fourteen
  sites. The tracking tokens are switched off and the tighter leading loosened
  under `:dir(rtl)`, with a paired rule so English blocks inside a
  right-to-left site keep their Latin typography.
- **`src/i18n/fa.json`.** An RTL site rendered English chrome, because `en.json`
  was the only translation that shipped.

### Changed

- **The docs are seven task-focused pages rather than one 801-line README.**
  The front page is 125 lines; everything else moved to `docs/`.

### Verification

- Ten new checks, each shown to fail before it was trusted: five over the built
  pages, and five source lints for what a rebuild cannot see — an ancestor
  `[dir=]` reaching into `.prose`, the emitted attribute names against the
  script's `dataset` keys, a bidi treatment on every class built in the browser,
  and the play triangle, which is identical in both mirror builds.
- The theme suite's flipped rebuild gains one positive statement, that a preview
  running the other way still declares itself, which is the only thing that can
  prove that half is symmetric.
- Every shipped translation is now checked for key parity and `{placeholder}`
  parity against `en.json`. Nothing checked `fa.json` at all, and a missing key
  degrades silently to English.
- `directionAttributes` in `scripts/lib/verify.mjs` matched `\bdir="…"`, and the
  `-` in `data-preview-title-dir` is a word boundary, so it read a `data-*` value
  as the element's own direction and pushed it onto the inheritance stack.

Byte-identity for a single-script vault holds. HTML moves in exactly three
places, each conditional on the text disagreeing with the page.

## [0.7.2] - 2026-09-04

### Fixed

- **0.7.1 could not be installed.** Its `package-lock.json` was regenerated with
  `npm install --package-lock-only` on macOS, which prunes `optional: true`
  packages that other platforms need — here `@emnapi/core` and
  `@emnapi/wasi-threads`. `npm ci` then refuses on Linux with *"can only install
  packages when your package.json and package-lock.json are in sync"*, so CI and
  every host build failed. Restored, with only the three stale metadata fields
  (the root `version`, twice, and `engines.node`) edited by hand.

  **If you are on 0.7.1, take this.** Nothing else differs between them.

  The lesson, since it is easy to repeat: on macOS `npm install` will offer to
  drop those two entries again, and that diff must not be committed. A clean
  `git status` on one platform is not worth a lockfile that cannot be installed
  on the platform every build actually runs on.

## [0.7.1] - 2026-09-04

**Superseded by 0.7.2, which is the same release with an installable lockfile.**

### Added

- **An update button.** `.github/workflows/update-theme.yml` ships with every
  copy: **Actions → Update theme → Run workflow** merges jotter onto an
  `update-theme` branch inside your own repository and gives you a pull request.
  It never writes to your default branch, and it works on a template copy, which
  GitHub's own "Sync fork" cannot: the unrelated-histories rule is about pull
  requests *between* repositories, and a branch in your own repository is not
  one.

  Two of GitHub's defaults get in the way and are handled rather than hit. It
  falls back to pushing the branch and handing you a link when a workflow is not
  allowed to open a pull request; and it stops *before* merging, naming the
  files, when an update changes something under `.github/workflows/`, which the
  built-in token may never push and cannot be granted permission to. An optional
  `UPDATE_TOKEN` secret lifts both.
- `docs/updating.md` now covers both paths, when a fork is the better one, and
  how to give the button a token.

## [0.7.0] - 2026-09-04

### The build stopped writing to files you own

Everything an Open Publish build generates now lives under `.jotter/`, which is
git-ignored and which nothing but the build touches.

- **`jotter.config.ts` is never regenerated.** The mapped site options go to
  `.jotter/site.json`, and the config file reads them as
  `defineConfig(generated ?? { … })` — a replacement, not a merge. The file is
  yours, it is written once by a person, and a build leaves it byte-identical.
- **Your notes folder is never deleted.** A fetch writes to `.jotter/vault` and
  wipes only that. It used to `rm -rf src/content/notes/`, a tracked directory
  the README tells people to put their own vault in.
- `npm run clean` removes `.jotter/`, and `.gitignore` covers it.

**Upgrading:** most sites take this as a clean merge. The fetch ran on the
host's own workspace, so the rewritten `jotter.config.ts` and the emptied
`src/content/notes/` were never in anybody's clone.

The exception is a repository where somebody ran a *configured* build locally
(`OP_*` set) and then committed the result. That leaves a generated
`jotter.config.ts` in git, and this release edits the same file, so it is the
one path that conflicts. Take upstream's copy — your settings live in Obsidian
and arrive on the next publish:

```bash
git checkout --theirs jotter.config.ts
```

Nothing else in this release touches a path you own.

### Fixed

- **`vault:` was ignored by the fetch.** `scripts/fetch-content.mjs` wrote to a
  hardcoded `src/content/notes` while `astro.config.ts`, `src/content.config.ts`
  and `src/lib/site.ts` all read the configured path, so setting `vault:` and
  publishing gave you an empty site. The fetch now writes the path it reports,
  and reports the path it wrote.
- **`astro.config.ts` and `src/lib/site.ts` resolved `vault:` against different
  bases** (`import.meta.url` and `process.cwd()`), which agreed only because the
  config file sits at the repository root. Both go through `resolveVaultRoot`.
- **jotter's own CI no longer runs in your repository.** `.github/workflows/ci.yml`
  is guarded on `github.repository`. It ran `verify:full` on every push to a
  copy: rewriting `jotter.config.ts`, building a synthetic 1,000-note vault and
  asserting against demo fixtures that do not exist in your vault. GitHub
  auto-disables only *scheduled* workflows on a fork, so this had to be a guard
  rather than a hope.

### Added

- **`src/user/*.astro` overrides.** Drop `src/user/Header.astro` in and it
  renders instead of jotter's. Slots: `Header`, `Sidebar`, `Frontmatter`,
  `PrevNext`, plus `Head` (last in `<head>`) and `Footer` (after `<main>`), which
  have no jotter component behind them. This replaces the old advice to paste an
  analytics snippet into `src/layouts/Base.astro`, one of the files an update
  changes most often. See [src/user/README.md](src/user/README.md).
- **Translations are found by a glob.** `src/i18n/fa.json` is now the whole
  procedure; there is no list in `src/i18n/index.ts` to add a line to. That line
  lived in a file upstream owns, so shipping a translation used to cost a merge
  conflict later.
- **`dist/_publish.json` carries `starter: { name, version }`**, read from
  `package.json`. Obsidian's **Check** button reports it, so a site can say which
  jotter it is running. Optional on both sides: a site built by an older starter
  reports no version and publishes exactly as before.

[0.8.0]: https://github.com/navidkashani/jotter/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/navidkashani/jotter/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/navidkashani/jotter/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/navidkashani/jotter/releases/tag/v0.7.0
