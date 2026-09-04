# Building from an Open Publish snapshot

[Open Publish](https://github.com/navidkashani/open-publish) is an Obsidian
plugin that pushes a chosen subset of a vault into object storage, then asks a
host to rebuild. This repository can be that host.

Two scripts do it, and both do nothing when the bucket is not configured. With
none of the `OP_*` variables set, `npm run build` builds the folder of markdown
at `vault:` exactly as it always has. Everything below is opt-in.

```
npm run build
  └─ node scripts/fetch-content.mjs     the snapshot becomes .jotter/vault
  └─ astro build                        jotter builds it
  └─ node scripts/verify-build.mjs      the assertions over dist/
  └─ node scripts/finalize.mjs          the marker the plugin polls
```

`finalize` runs **after** `verify`, so a build that failed jotter's own gate
never gets a `_publish.json` and the plugin cannot report a broken deploy as the
live one.

## Set these on your host

Four are required, and they are the read-only storage token the plugin issues.
On Cloudflare Pages they go in Settings → Environment variables; on Cloudflare
Workers Builds, in Settings → Build → Build Variables and Secrets; on Netlify
and Vercel, in the site's build settings.

| Variable | |
| --- | --- |
| `OP_ENDPOINT` | Storage endpoint, e.g. `https://<account>.r2.cloudflarestorage.com` |
| `OP_BUCKET` | Bucket name |
| `OP_ACCESS_KEY_ID` | Read-only key id |
| `OP_SECRET_ACCESS_KEY` | Read-only secret |
| `OP_REGION` | Optional. Defaults to `auto`, which is right for R2 |
| `OP_PREFIX` | Optional. A prefix inside the bucket, when one bucket holds several sites |
| `OP_FORCE_PATH_STYLE` | Optional. `false` for virtual-host addressing |
| `OP_SITE_URL` | Your own address, overriding whatever the host injects. Optional everywhere except Workers Builds, which injects none |

**Set all four, or none of the eight.** Any `OP_*` variable turns the fetch on,
and the build stops and names whichever of the required four is then missing. A
typo in a build setting must not quietly publish the demo garden to your domain.

The site URL is worked out from `OP_SITE_URL`, then `CF_PAGES_URL`,
`DEPLOY_PRIME_URL`, `URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL`. With
none of them set, jotter emits no sitemap and no canonical links, which is a
smaller site rather than a wrong one, so it warns rather than failing.

### Cloudflare Workers Builds

[`wrangler.jsonc`](../wrangler.jsonc) ships in the repository root, so
connecting the repository to a Worker is the whole setup. The deploy reads the
output directory, the 404 page and the trailing-slash rule out of that file, and
`test/wrangler.test.ts` keeps the output directory in step with the build. One
line in it is yours: `name` has to match the Worker you created in the
dashboard, and Workers Builds fails the build when the two disagree.
`OP_SITE_URL` is required here, and this is the only host where that is true.

**Cloudflare Pages prints a warning about that file, and it is harmless.** Every
Pages build logs "A Wrangler configuration file was found but it does not appear
to be valid… Skipping file and continuing", and then succeeds. The file carries
no `pages_build_output_dir`, which is what keeps it invisible to Pages and lets
one repository deploy to both. Adding that key would instead make the file the
source of truth for the Pages build settings of every site already deployed from
this theme.

### The Node version is pinned

`.node-version` and `engines.node` name the same version, because hosts disagree
about where to look: Pages, Workers Builds and Netlify read the file, and Vercel
reads `engines`. Unpinned means the host chooses, and on a real build Pages
picked one version while development was happening on another. Change both
together, and run `npm test` and `npm run verify:full` before trusting the new
one.

## What the fetch does to this repository

Nothing you can see in `git status`. **Everything the fetch generates goes into
`.jotter/`**, which is git-ignored and which `npm run clean` removes:

| Path | What |
| --- | --- |
| `.jotter/vault/` | Your notes, deleted and rewritten on every build. A note dropped from the snapshot has to disappear from a warm CI workspace, so the directory is recreated from the manifest each time. |
| `.jotter/site.json` | The site options from Obsidian, mapped to jotter's config. |
| `.jotter/vault/.jotter/` | `links.json` and `embeds.json`, described below. |

`jotter.config.ts` reads `site.json` as `defineConfig(generated ?? { … })`, a
replacement rather than a merge, because the plugin has no site option for
`description`, `author`, `linkResolution` or `publishGate` and a merge would
leave the demo's own values showing under a real site. **The config file itself
is never written.** Edit it freely.

Both halves used to be written onto tracked paths, and the cost was a dirty
`git status` after every build, whose obvious answer is `git commit -a`. From
then on every upstream change to those paths was a merge conflict, and a site
that cannot take an update keeps whatever bugs it shipped with. See
[updating.md](updating.md).

## The site options, and what each becomes

| Obsidian | jotter |
| --- | --- |
| `title` | `title` |
| `locale` | `locale`: a BCP-47 tag, region-qualified: `fa-IR`, not `fa` |
| `dir` | `dir`: carried across, never re-derived here |
| `noIndex` | `noIndex`: `robots.txt` disallows everything, no sitemap, and `X-Robots-Tag` on every page |
| `strictLineBreaks` | `strictLineBreaks` |
| `showThemeToggle` | `features.themeToggle` |
| `showOutline` | `features.toc` |
| `showBacklinks` | `features.backlinks` |
| `showTags` | `features.tags` |
| `showSearch` | `features.search` |
| `showNavigation` | `nav: 'tree'` or `'none'` |
| `showGraph` | `features.graph` **and** `layout: 'panels'` |
| `showPageMetadata` | `features.metadata`: the dates and frontmatter block under the title |
| `showPrevNext` | `features.prevNext` |
| `showHoverPreview` | `features.hoverPreview` |
| `showInlineTitle` | `features.inlineTitle`: the note's own `<h1>`, on note pages only |
| `folders` | `folderNames`: what the vault calls each folder, recovered from the manifest |
| `analytics` | `analytics`, or `none` when the id is blank |
| `homepage` | *nothing: already applied* |

`.jotter/site.json` replaces `jotter.config.ts`'s literal outright on an Open
Publish build, so a key the mapping does not emit sits at its schema default,
and anything you need to flip has to travel in the snapshot. The escape hatch is
to delete the `generated ??` and keep your own literal, at the price of the site
options in Obsidian no longer reaching the site at all.

Four rows are not the straight mapping they look like.

- **The graph needs the layout.** jotter renders the graph in the right panel,
  and the column layout has no right panel.
- **The inline title is a note-page switch.** Obsidian Publish has no folder or
  tag pages, so hiding the inline title never meant them. Here the `<h1>` on a
  folder listing, a tag page or the 404 is the only thing naming that page, so
  it stays whatever this says; only `Note.astro` reads the flag.
- **Analytics with no id would fail the build.** A provider chosen in Obsidian
  with the id left blank falls back to no analytics, with a line in the build
  log, rather than stopping the deploy.
- **The homepage is already applied.** The plugin has given that note the slug
  `index`, which is what `/` is served from.

`dir` is derived from `locale` in Obsidian, and jotter carries the answer across
rather than working it out again. Chrome text is a separate question: an `fa-IR`
site gets `<html lang="fa-IR" dir="rtl">` immediately, and its buttons and
labels stay English until someone adds `src/i18n/fa.json`.

A site option this repository has never heard of is reported in the build log
and ignored, which is how you find out to update from the template. Three jotter
settings have no equivalent in a snapshot and stay at their defaults:
`features.rss`, `features.embeds` and `externalLinks`.

### The sidebar order

jotter's default sorts alphabetically, with the loose notes at the root of the
vault above the folders, because those are the front doors. Inside a folder it
is folders-first, the way a file tree reads.

Open Publish can override that. **Settings → Open Publish → Site options →
Customize navigation** arranges the sidebar folder by folder and leaves pages
out of it, and the snapshot carries the result as `nav: { order, hidden }`, in
slugs. Where it speaks it wins outright; where it says nothing the default above
is untouched. A note can also say it itself with `nav-order:` or `nav-hidden:`,
and frontmatter wins over the dialog. A folder is named by the slug of its index
page, so the folder served at `/notes` is `notes/index` in both lists: a folder
and a note can want the same URL, and `notes` alone could not tell them apart.

**Hidden is not unpublished and not private.** A page left out of the sidebar is
still built, still at its own address, still in the search index, still in the
sitemap and still linked to from any note that links to it. jotter marks hidden
entries rather than dropping them, because that same tree generates the folder
routes and dropping a folder would take its page down.

Obsidian Publish's own hand-dragged order lives in its server-side site options,
so no plugin can import it. What arrives here was arranged in Open Publish.

## Dates, and which ones jotter believes

A vault fetched from a snapshot is written fresh into a directory this build
just deleted, so every fallback in `src/lib/dates.ts` collapses at once: no
frontmatter date, no git history, and an mtime of the instant `writeFile` ran.
All three land on *now*.

So the snapshot carries the file's `ctime` and `mtime`, and
`scripts/fetch-content.mjs` writes them into each note as `created:` and
`updated:`, **only when the note dates none of itself**. A note carrying any of
the ten spellings `src/lib/dates.ts` recognises keeps what its author wrote.

A note's own `created:` is the only trustworthy source, and the snapshot's
`ctime` is best effort: Obsidian takes it from the filesystem, and sync, a
restore from backup and an ordinary file transfer all reset it. One corruption
is cheap to catch and is caught: a creation date later than the last
modification is a copy operation's timestamp, so `mtime` wins. Where jotter has
no real date at all, it prints none.

## Old addresses become redirects, and the note does not move

A vault moving off Obsidian Publish carries `legacyUrls`, the addresses each
note used to answer at. The plugin also records every rename it has seen. Both
arrive in the note's frontmatter, under two keys of their own:

```yaml
---
title: "Critical Thinking"
aliases: ["Crit"]
oldUrls: ["Wisdom+&+Approaches/Critical+Thinking"]
renamedFrom: ["notes/critical-thinking"]
---
```

| Key | Redirect | Why |
| --- | --- | --- |
| `oldUrls:` | **301** | Nothing retracts what publish.obsidian.md served, so the address is permanent |
| `renamedFrom:` | **302** | Rename the note back and the plugin records the opposite move, so the rule reverses |
| `aliases:` | 302 | A name the author gave the note, and the only one of the three printed on the page |

Both address keys redirect **to** the note, so the note stays at the slug the
plugin published. Written to `permalink:` instead it would be the other way
round, with the address the plugin published redirecting to the old one.

The 301/302 split matters because a 301 outlives the build that wrote it.
Browsers cache one indefinitely, so a browser holding the withdrawn half of a
reversed pair loops until it gives up with `ERR_TOO_MANY_REDIRECTS`. Merged into
a single list, as they once were, every rule was permanent, including the ones a
later build withdraws. `aliases:` is separate again because
`src/components/Frontmatter.astro` prints it under "Also known as", and
`About/How+to+Communicate` is not a name anybody gave a note.

The Quartz starter writes `legacyUrls` into `permalink:` instead, because Quartz
runs every alias through its own slugifier. jotter honours both keys, so a vault
that starter prepared still works here. See [url-styles.md](url-styles.md).

## Links, and why no note body is rewritten

The plugin resolves every wikilink inside Obsidian, against the whole vault,
with your own settings: attachment folders, aliases, shortest-path matching over
notes that were never published. Nothing that sees only the published subset can
reproduce that. So the answers are written to `<vault>/.jotter/links.json`, and
[`src/lib/links-index.ts`](../src/lib/links-index.ts) reads them, alongside
`embeds.json` for posters and tweet text. Note bodies arrive byte for byte as
their author wrote them, plus a `title:`, an `aliases:`, an `oldUrls:` and the
note's dates. A link to a note that was not published renders as an inert
`<span class="dead-link">` labelled with what the author typed, never with the
unpublished note's title.

**Markdown is written at its slug; attachments are written at their vault
path.** A note's slug is an address the plugin published and other people link
to. An attachment has no such address, and `resolveAsset` matches an embed on
the file's basename, so a slugified `My Diagram.png` would make
`![[My Diagram.png]]` resolve to nothing.

## The marker the plugin polls

After a passing build, `finalize.mjs` writes:

- **`dist/_publish.json`**: `{ snapshot, builtAt }`. The plugin polls this every
  3 to 15 seconds for ten minutes after a publish. Without it, every publish
  ends in "still waiting" on a site that went live minutes earlier.
- **`dist/_headers`**: `Cache-Control: no-store` on the marker, so a CDN cannot
  serve a stale one, plus `X-Robots-Tag: noindex, nofollow` when `noIndex` is
  set. An existing `_headers` is merged, not replaced.

`robots.txt` is not written here. jotter's vault integration already writes it
on every build, and its `noIndex` output is byte-identical.

## When a build stops

Every failure names the file or the setting that caused it.

| Message | What happened |
| --- | --- |
| `Missing environment variable(s): …` | Some of the four are set and some are not |
| `Storage rejected the build credentials (403)` | The token is wrong, or not scoped to this bucket. Not retried: a revoked token will not fix itself |
| `No content has been published yet` | `current.json` is not in the bucket, or `OP_PREFIX` points somewhere else |
| `… is not in the bucket` | `current.json` names a snapshot a cleanup removed. Publish again |
| `"<file>" downloaded corrupted` | The object's sha256 did not match the manifest |
| `… is missing from storage` | The manifest lists a file whose object was never uploaded. The publish was probably interrupted |
| `… escapes the vault directory` | A slug, an old URL or a rename that would write outside the vault. Checked before anything is deleted |
| `understands snapshot version 1` | The plugin has moved on. Update this repository from the jotter template |

## Two kinds of verify failure

`verify-build.mjs` runs between `astro build` and `finalize.mjs`, so anything it
fails on is a site that does not go live. It says out loud which kind of thing
each line is, and only one of the three can stop a deploy.

| Line | What it means | Stops the build |
| --- | --- | --- |
| `FAIL` | A rule jotter guarantees on every site it builds. A page without a `<main>`, a dead link rendered as a working `<a>`, a canonical that spells a URL differently from the links pointing at it | Yes |
| `note` | An observation about your content. Notes embedding files from another origin, an image whose dimensions jotter cannot know, a hand-written link to a page that is not there | No |
| `skip` | A guard on this repository's own demo garden, meaningless on your vault | No |

A `note` is yours to act on in your own time, and your site is live either way.
A `FAIL` is a bug in the theme: the vault did not cause it, and no change to a
note will fix it. Open an issue with the line it printed.

The line at the top of the run says which mode it is in. `JOTTER_DEMO=1` marks a
build as this repository's own demo, which is what turns the `skip` lines into
real checks. CI sets it, and nothing about a site built from a snapshot should.

The durable half of that split is that **the checks a user cannot pass are not
in the script a user runs.** `scripts/verify-build.mjs` reads `dist/` and
nothing else. The passes that rebuild this repository under configurations
nobody ships are `scripts/verify-theme.mjs`, which `npm run build` never calls.

## Testing it without a bucket

`test/snapshot.test.ts` runs the real `fetch-content.mjs` against a synthetic
bucket served over loopback, in a scratch directory, so nothing in the
repository is touched.

`npm run verify:full` goes further. It fetches a fixture snapshot, builds it,
and asserts on the finished `dist/` that each note is at the slug the plugin
published, that the old Obsidian address 301s to it without moving the note,
that an unpublished link is inert, and that `_publish.json` carries the snapshot
`current.json` named. It also builds a deliberately unremarkable vault with
`JOTTER_DEMO` removed, so a check only the demo can satisfy is never one your
deploy has to satisfy.
