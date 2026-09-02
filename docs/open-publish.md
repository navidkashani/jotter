# Building from an Open Publish snapshot

[Open Publish](https://github.com/navidkashani/open-publish) is an Obsidian
plugin that pushes a chosen subset of a vault into object storage as an
immutable, content-addressed snapshot, and then asks a host to rebuild. This
repository can be that host.

Two scripts do it, and both **no-op when the bucket is not configured**. With
none of the `OP_*` variables set, `npm run build` builds the folder of markdown
in `src/content/notes/` exactly as it always has: no manifest, no network, no
change to the demo garden. Everything below is opt-in by environment variable.

```
npm run build
  └─ node scripts/fetch-content.mjs     the snapshot becomes a vault
  └─ astro build                        jotter builds it
  └─ node scripts/verify-build.mjs      jotter's own assertions
  └─ node scripts/finalize.mjs          the marker the plugin polls
```

`finalize` runs **after** `verify`, and that ordering is the point: a build that
failed jotter's own gate never gets a `_publish.json`, so the plugin cannot
report a broken deploy as the live one.

---

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

**Set all four, or none of the eight.** Any `OP_*` variable in the table turns
the fetch on; with some of the required four then missing, the build stops and
names them. A typo in a build setting must not quietly publish the demo garden
to your domain.

The site URL is worked out from `OP_SITE_URL`, then `CF_PAGES_URL`,
`DEPLOY_PRIME_URL`, `URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL`. With
none of them set, jotter emits no sitemap and no canonical links (a smaller
site, not a wrong one), so it is a warning rather than a failure. Cloudflare
Workers Builds injects no address at all, and is the one host where you have to
set `OP_SITE_URL` yourself.

### Cloudflare Workers Builds

There is no configuration to write by hand any more.
[`wrangler.jsonc`](../wrangler.jsonc) ships in the repository root, so
connecting the repository to a Worker is the whole setup: the deploy reads the
output directory, the 404 page and the trailing-slash rule out of that file.
Each of the three carries a comment saying why it holds the value it does, and
`test/wrangler.test.ts` keeps the output directory in step with the build,
because a directory that has drifted deploys an empty site and still reports
success.

One line in it is yours. `name` has to match the Worker you created in the
dashboard, and Workers Builds fails the build when the two disagree, so change
that line rather than renaming the Worker.

`OP_SITE_URL` is still required here, and this is the only host where that is
true. Workers Builds tells the build nothing about where the site will be
served, so with the variable unset the build warns and the site goes out with no
sitemap and no canonical links.

The file carries no `pages_build_output_dir`, which is what keeps it invisible
to Cloudflare Pages: a Wrangler file without that key is used for local
development only, so a site already deployed from Pages is untouched by it.
Netlify and Vercel never read it at all.

### The line Cloudflare Pages prints about `wrangler.jsonc`

Invisible is not the same as silent. Every Pages build of a site made from this
theme logs this, and then succeeds:

```
Found wrangler.json file. Reading build configuration...
A Wrangler configuration file was found but it does not appear to be valid.
Did you mean to use wrangler.toml to configure Pages? If so, then make sure
the file is valid and contains the `pages_build_output_dir` property.
Skipping file and continuing.
```

**Expected, and harmless.** "Skipping file and continuing" is Pages declining to
read a file that was never addressed to it, which is exactly the arrangement
that lets one repository deploy to both Pages and Workers Builds. Nothing about
your site is misconfigured, and no build has ever failed because of it. It is
documented here because "does not appear to be valid" is the kind of line
somebody debugging an unrelated failure will chase for an hour.

Adding `pages_build_output_dir` to make it stop is not the fix. That was tested
rather than assumed, and it fails in both directions:

- `wrangler deploy` starts warning that this "is a Pages project" and that
  "proceeding will likely produce unwanted results", then stops for a
  confirmation that only a non-interactive fallback answers. A Workers Builds
  deploy would be riding on that fallback.
- The key is precisely what promotes the file from local-development-only to
  the source of truth for a Pages project's configuration. Adding it would
  silently take over the dashboard build settings of every Pages site already
  deployed from this theme.

So the warning stays, and this section is the whole fix.

### The Node version is pinned

`.node-version` in the repository root says `24.20.0`, and `engines.node` agrees
with it. Cloudflare Pages and Workers Builds both read that file, and so do
Netlify, `fnm` and `nodenv`. Vercel reads `engines.node` instead, which is the
other half of why both say the same thing. CI reads the file directly rather
than naming a version of its own, so a green run means the theme built on the
version your host will use.

It is pinned rather than floating because unpinned means the host chooses. On a
real build, Pages picked 22.16.0 while development was happening on 24.x and
`undici` warned that it wanted 22.19.0 or newer: three different answers, none
of them chosen, and a warning today is a broken build on a version you cannot
reproduce locally tomorrow.

`24.20.0` is the current Node LTS, and moving it is a decision somebody makes.
When you do move it, change `.node-version` and `engines.node` together, and
run `npm test` and `npm run verify:full` on the new version before trusting it.

---

## What the fetch does to this repository

This is the part to read before the first build.

**`src/content/notes/` is emptied and rewritten.** A note removed from the
snapshot has to disappear from a warm CI workspace, so the directory is deleted
and recreated from the manifest. Anything you left in it locally is gone.

**`jotter.config.ts` is regenerated**, from the site options you set in Obsidian
under Settings → Open Publish → Site options. It arrives with a "do not
hand-edit" banner and the build says so out loud. Edit it and your next publish
overwrites the edit.

What stays yours: `src/styles/custom.css`, the strings in `src/i18n/*.json`, and
every component in `src/`. Nothing in this pipeline touches them.

**Two files are written into the vault beside your notes**, both under
`.jotter/`, which the scan ignores as a directory and reads as data:
`links.json` (every wikilink, resolved inside Obsidian: see below) and
`embeds.json` (posters and tweet text, fetched from the network: see
"Obsidian syntax support" in [the README](../README.md)). A poster downloaded
for a video facade lands
in `attachments/embeds/` and is served from your own site like any other image.

---

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
| `analytics` | `analytics`, or `none` when the id is blank |
| `homepage` | *nothing: already applied* |

Two of those arrived to answer the same question twice, and it is worth knowing
why they are site options rather than jotter config keys. **`fetch-content.mjs`
regenerates `jotter.config.ts` on every build**, so a key `mapSite` does not
emit is frozen at its schema default and cannot be changed from anywhere: not in
Obsidian, and not by editing the file, because the next build overwrites it.
Anything you need to flip has to travel in the snapshot. (`src/styles/custom.css`
and `src/i18n/` are the two surfaces that survive regeneration.)

`showPageMetadata` is **off** by default, which is what Obsidian Publish does:
it shows none of this. Turned on, jotter still prints a date only where it has a
real one: see the next section.

Three of those are not the straight mapping they look like.

**The graph needs the layout.** jotter renders the graph in the right panel, and
the column layout has no right panel, so `features.graph` alone is a flag that
is on and a feature that never draws. Asking for a graph therefore also asks for
`layout: 'panels'`.

**Analytics with no id would fail the build.** The plugin defaults the id to an
empty string, and jotter's config requires one unless the provider is `none`. A
provider chosen in Obsidian with the id left blank falls back to no analytics,
with a line in the build log, rather than stopping the deploy over it.

**The homepage is already applied.** `homepage` is a vault path, and the plugin
has given that note the slug `index`, which is what `/` is served from. Copying
it into jotter's `homepage`, which takes a *slug*, would be a second answer to a
settled question.

**The language decides the direction, in Obsidian.** `dir` is not a control
anybody sets: the plugin derives it from `locale` through a closed table of the
tags it will publish, and jotter carries the answer across rather than working
it out again. One table in one place is one answer, and a starter with no
direction concept of its own still receives the right one instead of guessing.

Chrome text is a separate question from layout. An `fa-IR` site gets `<html
lang="fa-IR" dir="rtl">` and a right-to-left layout immediately, but its
buttons and labels stay English until someone adds `src/i18n/fa.json` and
registers it in `src/i18n/index.ts`. The lookup tries the whole tag before the
language alone, so either `fa-IR.json` or `fa.json` is found. That directory is
yours and survives every rebuild.

A site option this repository has never heard of is reported in the build log
and ignored, which is how you find out to update from the template. Four jotter
settings have no equivalent in a snapshot and stay at their defaults:
`features.hoverPreview`, `features.rss`, `features.embeds` and `externalLinks`.
The last two are deliberate rather than pending: click-to-play embeds and the
`↗` on an outbound link have a defensible default each, and three more site
options is too high a price for a preference.

**One thing Obsidian Publish has that no plugin can import.** Its sidebar order
is hand-dragged, and that order lives in Obsidian Publish's *server-side* site
options rather than in `.obsidian/publish.json`, so there is nothing on disk for
the plugin to read. jotter sorts alphabetically, with one adjustment that gets
most of the way there for free: the loose notes at the root of the vault sort
*above* the folders, because those are the front doors (Welcome, Now, Start
here) and under the folders they sat at the bottom of the sidebar. Inside a
folder it is folders-first, the way a file tree reads. A deliberate order needs
`config.redirects`-style hand editing, which regeneration would overwrite; there
is no good answer today, and pretending otherwise would be worse than saying so.

---

## Dates, and which ones jotter believes

A vault fetched from a snapshot is written fresh into a directory this build
just deleted. Every fallback in `src/lib/dates.ts` therefore collapses at once:
the author wrote no frontmatter date, there is no git history, and the mtime is
the instant `writeFile` ran. All three land on *now*, which is why every note on
a site built this way used to read `Created` as the day of the last deploy.

So the snapshot carries the file's `ctime` and `mtime`, and
`scripts/fetch-content.mjs` writes them into each note:

```yaml
---
title: "Critical Thinking"
created: "2024-03-14T00:00:00.000Z"
updated: "2026-01-09T00:00:00.000Z"
---
```

**Only when the note dates none of itself.** A note carrying any of the ten
spellings `src/lib/dates.ts` recognises (`created`, `date`, `created_at`,
`createdAt`, `published`, and the five `updated` ones) keeps what its author
wrote, untouched.

That precedence is not politeness, it is accuracy. Obsidian takes `ctime` from
the filesystem, and the filesystem loses it: sync, a restore from backup and an
ordinary file transfer all reset it to the moment the copy landed, which is why
Obsidian's own forum carries a long-standing request to stop deriving it that
way and why plugins exist whose whole job is to write a creation date into
frontmatter. **A note's own `created:` is the only trustworthy source**; the
snapshot's `ctime` is best effort. The one corruption cheap to catch is caught:
a creation date later than the last modification is a copy operation's
timestamp, not a note edited before it existed, so `mtime` wins.

And where jotter has no real date at all, it prints none. `features.metadata`
on a vault with no dates and no git history shows the other frontmatter fields
and no `Created` row, rather than the build's own clock.

---

## Old addresses become redirects, and the note does not move

A vault moving off Obsidian Publish carries `legacyUrls`: the addresses each
note used to answer at, like `Wisdom+&+Approaches/Critical+Thinking`. The plugin
also records every rename it has seen.

Both arrive in the note's frontmatter as **`oldUrls:`**, never as `permalink:`
and never as `aliases:`:

```yaml
---
title: "Critical Thinking"
aliases: ["Crit"]
oldUrls: ["Wisdom+&+Approaches/Critical+Thinking"]
---
```

`buildRedirects` runs an old URL through `sourceFor(url, 'preserve')` (NFC and
nothing else), and then through the one URL encoder in the build, so that line
becomes a 301 from `/Wisdom+%26+Approaches/Critical+Thinking` to the slug the
plugin published, and **the note stays where it is**. Written to `permalink:`
instead it would be the other way round: the address the plugin published would
301 to the address the site used to have, backwards.

**And a key of its own, not more `aliases:`.** Both become 301s, so routing
never told them apart; the page did. `src/components/Frontmatter.astro` prints
`aliases` under the heading "Also known as", so every note on a vault migrated
from Obsidian Publish displayed `About/How+to+Communicate` as human metadata.
An alias is a name the author gave the note. An old URL is routing data that
somebody happened to publish. `oldUrls` is written whole rather than merged,
because unlike `aliases` it holds no author content: the snapshot is the
authority on which addresses this note used to answer at.

This is why nothing in this pipeline writes `_redirects` of its own. jotter had
a redirect writer already; it just needed to be told the names.

The Quartz starter does write `legacyUrls` into `permalink:`, because Quartz
runs every alias through its own slugifier and `permalink` is the one key it
honours character for character. jotter honours both, so it can pick the one
that keeps the note in place. A vault prepared by the Quartz starter still
works here (see [url-styles.md](url-styles.md)).

---

## Links, and why no note body is rewritten

The plugin resolves every wikilink *inside Obsidian*, against the whole vault,
with your own settings: attachment folders, aliases, shortest-path matching
over notes that were never published. Nothing that sees only the published
subset can reproduce that.

So the answers are written to `<vault>/.jotter/links.json`, in the manifest's own
shape, and [`src/lib/links-index.ts`](../src/lib/links-index.ts) reads them. Note
bodies arrive byte for byte as their author wrote them, plus a `title:`, an
`aliases:`, an `oldUrls:` and the note's dates in the frontmatter. A link to a
note that was not published renders as an inert `<span class="dead-link">`
labelled with what the author typed: never with the unpublished note's title.

One re-keying happens on the way in: the manifest keys links by vault path, and
jotter looks them up by the note's on-disk path, which after the fetch is
`<slug>.md`.

**Markdown is written at its slug; attachments are written at their vault path.**
That difference is deliberate. A note's slug is an address the plugin published
and other people link to. An attachment has no such address (jotter serves
attachments from `/_vault/<path>`, which the plugin never sees), and
`resolveAsset` matches an embed on the file's *basename* without consulting the
link index, so a slugified `My Diagram.png` would make `![[My Diagram.png]]`
resolve to nothing.

---

## The marker the plugin polls

After a passing build, `finalize.mjs` writes:

- **`dist/_publish.json`**: `{ snapshot, builtAt }`. The plugin polls this every
  3 to 15 seconds for ten minutes after a publish. Without it, every publish ends
  in "still waiting" on a site that went live minutes earlier.
- **`dist/_headers`**: `Cache-Control: no-store` on the marker, so a CDN cannot
  serve a stale one and have the plugin report an old snapshot as live, plus
  `X-Robots-Tag: noindex, nofollow` when `noIndex` is set. An existing `_headers`
  is merged, not replaced.

`robots.txt` is not written here. jotter's vault integration already writes it on
every build, and its `noIndex` output is byte-identical.

---

## When a build stops

Every failure names the file or the setting that caused it.

| Message | What happened |
| --- | --- |
| `Missing environment variable(s): …` | Some of the four are set and some are not |
| `Storage rejected the build credentials (403)` | The token is wrong, or not scoped to this bucket. Not retried: a revoked token will not fix itself |
| `No content has been published yet` | `current.json` is not in the bucket, or `OP_PREFIX` points somewhere else |
| `… is not in the bucket` | `current.json` names a snapshot a cleanup removed. Publish again |
| `"<file>" downloaded corrupted` | The object's sha256 did not match the manifest. Refusing to publish content that does not match the snapshot |
| `… is missing from storage` | The manifest lists a file whose object was never uploaded. The publish was probably interrupted |
| `… escapes the vault directory` | A slug, an old URL or a rename that would write outside the vault. Checked before anything is deleted, so the vault is left as it was |
| `understands snapshot version 1` | The plugin has moved on. Update this repository from the jotter template |

---

## Two kinds of verify failure

`verify-build.mjs` runs between `astro build` and `finalize.mjs`, so anything it
fails on is a site that does not go live. It therefore says out loud which kind
of thing each line is, and only one of the three can stop a deploy.

| Line | What it means | Stops the build |
| --- | --- | --- |
| `FAIL` | An **invariant**: something jotter guarantees about every site it builds. A page without a `<main>`, a dead link rendered as a working `<a>`, a canonical that spells a URL differently from the links pointing at it | Yes |
| `note` | An **observation**: something true of your content that you decided. Notes embedding files from another origin, an image whose dimensions jotter cannot know, a hand-written link to a page that is not there | No |
| `skip` | A **demo-integrity guard**: a check that this repository's own demo garden still exercises some case, so the assertions beside it are not passing on an empty set. Meaningless on your vault, and skipped there | No |

So: a `note` is yours to act on, in your own time, and your site is live either
way. A `FAIL` is a bug in the theme. The vault did not cause it, and no change
to a note will fix it. Open an issue with the line it printed.

The line at the top of the run says which mode it is in. `JOTTER_DEMO=1` marks
a build as this repository's own demo, which is what turns the `skip` lines into
real checks; CI sets it, and nothing about a site built from a snapshot should.

A worked example of the distinction, because it is what the split was written
for. A vault kept its notes in a folder called `notes`, embedded two PDFs with
`![[Integrity.pdf]]`, and pasted a tweet and a YouTube URL as `![](…)`. That
built correctly and then failed eight checks, five of which were about fixtures
that only exist in `src/content/notes/`. None of the eight was a reason not to
publish. Today the demo guards skip, the content facts report, and the two real
bugs in that list are fixed: a PDF emitted as an `<img>` no browser draws, and
a listing check that read any folder called `notes` as jotter's own index.

---

## Testing it without a bucket

`test/snapshot.test.ts` runs the real `fetch-content.mjs` against a synthetic
bucket served over loopback, in a scratch directory, so nothing in the
repository is touched. `npm run verify:full` goes further: it fetches a fixture
snapshot, builds it, and asserts on the finished `dist/` that each note is at
the slug the plugin published, that the old Obsidian address 301s to it without
moving the note, that an unpublished link is inert, and that `_publish.json`
carries the snapshot `current.json` named.

It also builds a deliberately unremarkable vault (a folder called `notes`, two
PDF embeds, a tweet URL, a YouTube URL, and none of the demo's dead links, SVG
or probe pages) and runs the real `verify-build.mjs` over it with `JOTTER_DEMO`
removed from the environment. Its exit code is the assertion. That section is
what stops a check that only the demo can satisfy from ever again being one your
deploy has to satisfy.
