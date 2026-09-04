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

## [Unreleased]

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

[Unreleased]: https://github.com/navidkashani/jotter/compare/v0.7.0...main
[0.7.0]: https://github.com/navidkashani/jotter/releases/tag/v0.7.0
