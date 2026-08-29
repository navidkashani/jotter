# Building from an Open Publish snapshot

[Open Publish](https://github.com/navidkashani/open-publish) is an Obsidian
plugin that pushes a chosen subset of a vault into object storage as an
immutable, content-addressed snapshot, and then asks a host to rebuild. This
repository can be that host.

Two scripts do it, and both **no-op when the bucket is not configured**. With
none of the `OP_*` variables set, `npm run build` builds the folder of markdown
in `src/content/notes/` exactly as it always has — no manifest, no network, no
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
On Cloudflare Pages they go in Settings → Environment variables; on Netlify and
Vercel, in the site's build settings.

| Variable | |
| --- | --- |
| `OP_ENDPOINT` | Storage endpoint, e.g. `https://<account>.r2.cloudflarestorage.com` |
| `OP_BUCKET` | Bucket name |
| `OP_ACCESS_KEY_ID` | Read-only key id |
| `OP_SECRET_ACCESS_KEY` | Read-only secret |
| `OP_REGION` | Optional. Defaults to `auto`, which is right for R2 |
| `OP_PREFIX` | Optional. A prefix inside the bucket, when one bucket holds several sites |
| `OP_FORCE_PATH_STYLE` | Optional. `false` for virtual-host addressing |
| `OP_SITE_URL` | Optional. Your own address, overriding whatever the host injects |

**Set all four, or none of the eight.** Any `OP_*` variable in the table turns
the fetch on; with some of the required four then missing, the build stops and
names them. A typo in a build setting must not quietly publish the demo garden
to your domain.

The site URL is worked out from `OP_SITE_URL`, then `CF_PAGES_URL`,
`DEPLOY_PRIME_URL`, `URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL`. With
none of them set, jotter emits no sitemap and no canonical links — a smaller
site, not a wrong one — so it is a warning rather than a failure. Cloudflare
Workers Builds injects no address at all, and is the one host where you have to
set `OP_SITE_URL` yourself.

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

---

## The site options, and what each becomes

| Obsidian | jotter |
| --- | --- |
| `title` | `title` |
| `noIndex` | `noIndex` — `robots.txt` disallows everything, no sitemap, and `X-Robots-Tag` on every page |
| `strictLineBreaks` | `strictLineBreaks` |
| `showThemeToggle` | `features.themeToggle` |
| `showOutline` | `features.toc` |
| `showBacklinks` | `features.backlinks` |
| `showTags` | `features.tags` |
| `showSearch` | `features.search` |
| `showNavigation` | `nav: 'tree'` or `'none'` |
| `showGraph` | `features.graph` **and** `layout: 'panels'` |
| `analytics` | `analytics`, or `none` when the id is blank |
| `homepage` | *nothing — already applied* |

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
has given that note the slug `index` — which is what `/` is served from. Copying
it into jotter's `homepage`, which takes a *slug*, would be a second answer to a
settled question.

A site option this repository has never heard of is reported in the build log
and ignored, which is how you find out to update from the template. Four jotter
settings have no equivalent in a snapshot and stay at their defaults:
`locale`, `dir`, `features.hoverPreview` and `features.rss`.

---

## Old addresses become redirects, and the note does not move

A vault moving off Obsidian Publish carries `legacyUrls` — the addresses each
note used to answer at, like `Wisdom+&+Approaches/Critical+Thinking`. The plugin
also records every rename it has seen.

Both arrive in the note's frontmatter as **`aliases:`**, never as `permalink:`,
and that is the whole design:

```yaml
---
title: "Critical Thinking"
aliases: ["Wisdom+&+Approaches/Critical+Thinking"]
---
```

`buildRedirects` runs an alias through `sourceFor(alias, 'preserve')` — NFC and
nothing else — and then through the one URL encoder in the build, so that line
becomes a 301 from `/Wisdom+%26+Approaches/Critical+Thinking` to the slug the
plugin published, and **the note stays where it is**. Written to `permalink:`
instead it would be the other way round: the address the plugin published would
301 to the address the site used to have, backwards.

This is why nothing in this pipeline writes `_redirects` of its own. jotter had
a redirect writer already; it just needed to be told the names.

The Quartz starter does write `legacyUrls` into `permalink:`, because Quartz
runs every alias through its own slugifier and `permalink` is the one key it
honours character for character. jotter honours both, so it can pick the one
that keeps the note in place. A vault prepared by the Quartz starter still
works here — see [url-styles.md](url-styles.md).

---

## Links, and why no note body is rewritten

The plugin resolves every wikilink *inside Obsidian*, against the whole vault,
with your own settings — attachment folders, aliases, shortest-path matching
over notes that were never published. Nothing that sees only the published
subset can reproduce that.

So the answers are written to `<vault>/.jotter/links.json`, in the manifest's own
shape, and [`src/lib/links-index.ts`](../src/lib/links-index.ts) reads them. Note
bodies arrive byte for byte as their author wrote them, plus a `title:` and
`aliases:` in the frontmatter. A link to a note that was not published renders as
an inert `<span class="dead-link">` labelled with what the author typed — never
with the unpublished note's title.

One re-keying happens on the way in: the manifest keys links by vault path, and
jotter looks them up by the note's on-disk path, which after the fetch is
`<slug>.md`.

**Markdown is written at its slug; attachments are written at their vault path.**
That difference is deliberate. A note's slug is an address the plugin published
and other people link to. An attachment has no such address — jotter serves
attachments from `/_vault/<path>`, which the plugin never sees — and
`resolveAsset` matches an embed on the file's *basename* without consulting the
link index, so a slugified `My Diagram.png` would make `![[My Diagram.png]]`
resolve to nothing.

---

## The marker the plugin polls

After a passing build, `finalize.mjs` writes:

- **`dist/_publish.json`** — `{ snapshot, builtAt }`. The plugin polls this every
  3 to 15 seconds for ten minutes after a publish. Without it, every publish ends
  in "still waiting" on a site that went live minutes earlier.
- **`dist/_headers`** — `Cache-Control: no-store` on the marker, so a CDN cannot
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
| `Storage rejected the build credentials (403)` | The token is wrong, or not scoped to this bucket. Not retried — a revoked token will not fix itself |
| `No content has been published yet` | `current.json` is not in the bucket, or `OP_PREFIX` points somewhere else |
| `… is not in the bucket` | `current.json` names a snapshot a cleanup removed. Publish again |
| `"<file>" downloaded corrupted` | The object's sha256 did not match the manifest. Refusing to publish content that does not match the snapshot |
| `… is missing from storage` | The manifest lists a file whose object was never uploaded. The publish was probably interrupted |
| `… escapes the vault directory` | A slug, an old URL or a rename that would write outside the vault. Checked before anything is deleted, so the vault is left as it was |
| `understands snapshot version 1` | The plugin has moved on. Update this repository from the jotter template |

---

## Testing it without a bucket

`test/snapshot.test.ts` runs the real `fetch-content.mjs` against a synthetic
bucket served over loopback, in a scratch directory, so nothing in the
repository is touched. `npm run verify:full` goes further: it fetches a fixture
snapshot, builds it, and asserts on the finished `dist/` that each note is at
the slug the plugin published, that the old Obsidian address 301s to it without
moving the note, that an unpublished link is inert, and that `_publish.json`
carries the snapshot `current.json` named.
