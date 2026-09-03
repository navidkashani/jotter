#!/usr/bin/env node
/**
 * Step 1 of a build from Open Publish: turn the published snapshot into a
 * vault directory jotter can scan.
 *
 *   current.json -> snapshots/<id>.json -> objects/<hash> -> <vault>/<slug>.md
 *
 * Every downloaded object is verified against the hash the snapshot recorded,
 * and a mismatch fails the build. That is the point: a corrupted object should
 * never reach the live site, and a failed build with a clear reason is a much
 * better outcome than a silently broken deploy.
 *
 * **It no-ops when the bucket is not configured.** With none of the `OP_*`
 * variables set this exits 0 having touched nothing, so a plain markdown folder
 * (the demo garden in this repository included) builds exactly as it did
 * before. With *some* of them set it fails, naming the ones that are missing: a
 * typo in a build setting must not quietly publish somebody else's notes.
 *
 * ## What it writes, and what it deliberately does not
 *
 * **Everything it writes lives under `.jotter/`**, which is git-ignored and
 * which nothing else writes to. Not one tracked file is touched, so a site fed
 * by this script has a clean working tree after every build and can take an
 * upstream update as a merge rather than as a series of conflicts. See
 * `GENERATED_DIR` below.
 *
 * Note bodies are written **byte for byte as their author wrote them**, plus a
 * `title:`, an `aliases:`, its old addresses and the note's dates in the
 * frontmatter. No link in any note is rewritten.
 * The Quartz starter has to rewrite them because Quartz cannot be told what a
 * wikilink resolves to; jotter can, so the plugin's own answers go to
 * `<vault>/.jotter/links.json` and `src/lib/links-index.ts` reads them.
 *
 * Old addresses become `oldUrls:` and `renamedFrom:`, which
 * `buildRedirectRules` turns into redirects without moving the note, and which
 * nothing renders: a 301 for the frozen Obsidian Publish addresses, a 302 for
 * the renames, which a later build can reverse. See `oldAddressesFor` in
 * `lib/snapshot.mjs`.
 *
 * Markdown is written at its **slug**; everything else is written at its
 * **vault path**. Those are not the same rule and the difference is load
 * bearing (see the comment on `targetFor` below).
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import { S3Reader, REQUIRED_ENV } from './lib/s3.mjs'
import {
  applyNoteMetadata,
  entryProblem,
  folderNamesFor,
  objectKey,
  oldAddressesFor,
  pool,
  readSnapshot,
  redirectFromsFor,
  reKeyLinks,
  sha256,
  snapshotDates,
} from './lib/snapshot.mjs'
import { collectEmbeds } from './lib/embeds.mjs'
import { mapSite, renderSiteJson } from './lib/site-config.mjs'
import { resolveSiteUrl } from './lib/site-url.mjs'
import { clearContentStores } from './lib/astro-cache.mjs'

/**
 * Every path this script touches is resolved against the working directory,
 * never against its own location. npm runs a script with the package root as
 * its cwd, so for a real build the two are the same, and keeping it this way
 * is what lets `test/snapshot.test.ts` run the real script against a scratch
 * directory instead of overwriting the config file of the repository it is
 * testing.
 */
const ROOT = process.cwd()
const STATE_FILE = join(ROOT, '.op-build-state.json')
const DOWNLOAD_CONCURRENCY = 8

/**
 * Everything this script generates, under one git-ignored directory it owns.
 *
 * Both halves used to be written onto tracked paths: the options went into
 * `jotter.config.ts` and the notes into `src/content/notes/`, and the README
 * named both as files a forker owns. So every build deleted or rewrote something
 * the theme had just invited somebody to edit, `git status` came back dirty, and
 * the obvious response (`git commit -a`) turned every future upstream change to
 * those paths into a merge conflict. A site that cannot take an update keeps
 * whatever bugs it shipped with, which is a worse outcome than any of the
 * warnings below.
 *
 * `.jotter/vault` is the default rather than a fixed rule: `JOTTER_VAULT_OVERRIDE`
 * still wins, and whichever wins is written into the generated options, so the
 * directory this script writes and the directory the build reads are the same
 * string rather than two hardcoded paths that agreed by luck.
 */
const GENERATED_DIR = '.jotter'
const OVERLAY_FILE = join(ROOT, GENERATED_DIR, 'site.json')
const DEFAULT_VAULT = `${GENERATED_DIR}/vault`

/** The path the theme shipped its demo garden at, which is now nobody's build output. */
const DEMO_VAULT = join(ROOT, 'src', 'content', 'notes')

/**
 * Every variable this script reads, as a closed list rather than an `OP_`
 * prefix scan.
 *
 * A prefix scan is the obvious way to write "is Open Publish configured?" and
 * it is wrong on a developer machine: the 1Password CLI puts
 * `OP_SERVICE_ACCOUNT_TOKEN` in the environment, and a plain `npm run build`
 * would then stop with a demand for four bucket variables the person has never
 * heard of. A closed list still catches the case that matters: a typo in one
 * name while the other three are spelled correctly.
 */
const OP_ENV = [...REQUIRED_ENV, 'OP_REGION', 'OP_PREFIX', 'OP_FORCE_PATH_STYLE', 'OP_SITE_URL']

const log = (message) => console.log(`[open-publish] ${message}`)
const note = (message) => console.log(`[open-publish] note: ${message}`)
const warn = (message) => console.warn(`[open-publish] warning: ${message}`)

function fail(message) {
  console.error(`\n[open-publish] Build stopped.\n\n${message}\n`)
  process.exit(1)
}

/**
 * Markdown at its slug, everything else at its vault path.
 *
 * The slug is the address the plugin published a *note* at, and writing the
 * file there is what makes `slugs: 'preserve'` serve that address. An
 * attachment has no such address: jotter serves attachments from
 * `/_vault/<path>`, which the plugin never sees, never reports and never
 * redirects to. Slugging one would only break it: `resolveAsset`
 * (`src/lib/resolve.ts:180`) matches an embed on the file's **basename** and
 * does not consult the link index, so `![[My Diagram.png]]` against a file
 * written as `my-diagram.png` resolves to nothing at all.
 */
const targetFor = (path, file, vault) =>
  path.toLowerCase().endsWith('.md')
    ? join(vault, ...`${file.slug}.md`.split('/'))
    : join(vault, ...path.split('/'))

async function main() {
  const configured = OP_ENV.filter((name) => process.env[name])
  if (configured.length === 0) {
    // Nothing to fetch. The vault on disk is the vault this build uses.
    return
  }

  /**
   * Before the bucket, and long before the vault directory is deleted: this
   * reads nothing but the environment, and the one thing it can refuse is a
   * misconfiguration that no amount of downloading would fix.
   */
  const { url, warning: urlWarning, error: urlError } = resolveSiteUrl(process.env)
  if (urlError) fail(urlError)

  const reader = S3Reader.fromEnv()
  /**
   * Relative and absolute both survive: `resolve` returns an absolute path
   * unchanged, and the same string goes into the generated options below, where
   * `src/lib/site.ts` resolves it against `process.cwd()` the same way.
   */
  const vaultPath = process.env.JOTTER_VAULT_OVERRIDE ?? DEFAULT_VAULT
  const vault = resolve(ROOT, vaultPath)

  const { pointer, snapshot } = await readSnapshot(reader, fail)
  log(`snapshot ${pointer.snapshot}`)

  const entries = Object.entries(snapshot.files ?? {})
  if (entries.length === 0) {
    fail(
      `Snapshot "${pointer.snapshot}" contains no files.\n` +
        'Choose some notes to publish in Obsidian, then publish again.',
    )
  }

  /**
   * Everything checkable without the network, checked before anything is
   * deleted. A snapshot that fails here leaves the vault directory exactly as
   * it was, which is the difference between a build that stops and a working
   * tree that has to be restored by hand.
   */
  const redirects = Array.isArray(snapshot.redirects) ? snapshot.redirects : []
  const problems = entries
    .map(([path, file]) => entryProblem(path, file, redirectFromsFor(file?.slug ?? '', redirects)))
    .filter(Boolean)

  /**
   * Two entries writing to one file, which the download pool would resolve by
   * whichever finished last. The plugin refuses a slug collision at scan time,
   * so this should be unreachable, and it is one line of `Map` for a failure
   * whose only other symptom is a note that silently is not on the site.
   */
  const claimed = new Map()
  for (const [path, file] of entries) {
    if (typeof file?.slug !== 'string') continue
    const target = targetFor(path, file, vault)
    const first = claimed.get(target)
    if (first) problems.push(`"${path}" and "${first}" would both be written to ${target}.`)
    else claimed.set(target, path)
  }

  if (problems.length > 0) {
    fail(
      `The snapshot holds ${problems.length} entr${problems.length === 1 ? 'y' : 'ies'} that ` +
        `cannot be written safely:\n\n${problems.map((p) => `  ${p}`).join('\n')}`,
    )
  }

  /**
   * A slug ending in `/index` is the one place `slugs: 'preserve'` is not
   * literally verbatim: `slugFor` pops a trailing `index` segment below the
   * root, so `folder/index` is served at `/folder`. Astro would route it there
   * regardless; saying so is how the author finds out before a reader does.
   */
  for (const [path, file] of entries) {
    if (file.slug.includes('/') && file.slug.endsWith('/index')) {
      warn(
        `"${path}" has the slug "${file.slug}", and a trailing "index" claims its folder, so ` +
          `jotter serves it at "/${file.slug.slice(0, -'/index'.length)}".`,
      )
    }
  }

  log(`${entries.length} file(s) to fetch`)

  /**
   * Start from an empty vault, then clear Astro's content stores.
   *
   * Both halves are needed on a warm CI workspace. Without the wipe, a note
   * deleted from the snapshot survives on disk; without the store clear, it
   * survives in the content layer's cache, which invalidates on a *source
   * file's* digest and so notices neither the deletion nor the rewritten
   * options below. See `lib/astro-cache.mjs`.
   *
   * The `rm` is only safe because of what `vault` now is. It used to point at
   * `src/content/notes/`, a tracked directory this repository ships a demo
   * garden in and the README tells people to put their own vault in, and it
   * deleted the lot on every build.
   */
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await clearContentStores(ROOT)

  /**
   * Files sitting in the old vault path that this build is not publishing.
   *
   * Reported rather than deleted, and reported *by name*, because the two ways
   * to arrive here need opposite answers and only their author knows which one
   * this is: the demo garden this repository ships (harmless, and deleting it
   * costs a modify/delete conflict on every future update), or somebody's real
   * notes, which are not on the site and which nobody would otherwise be told
   * about. A build that quietly did either would be wrong half the time.
   */
  if (vault !== DEMO_VAULT) {
    const stranded = await readdir(DEMO_VAULT).catch(() => [])
    const markdown = stranded.filter((name) => name.toLowerCase().endsWith('.md'))
    if (markdown.length > 0) {
      warn(
        `src/content/notes/ holds ${markdown.length} markdown file(s), and this build published ` +
          `${vaultPath} instead, so nothing in there reaches the site. Almost always that is ` +
          `jotter's own demo garden, which costs nothing to leave alone: deleting a file the ` +
          `theme ships is a modify/delete conflict on every future update. If they are your ` +
          `notes, publish them from Obsidian rather than pointing this build at them: an Open ` +
          `Publish build deletes and rewrites its vault directory from the snapshot every run.`,
      )
    }
  }

  let done = 0
  const warnings = []
  /** Note bodies, for the remote-embed scan after the downloads. */
  const bodies = []

  await pool(entries, DOWNLOAD_CONCURRENCY, async ([path, file]) => {
    const body = await reader.get(objectKey(file.hash))
    if (!body) {
      fail(
        `The snapshot lists "${path}" but its content is missing from storage ` +
          `(object ${file.hash}).\nPublish again from Obsidian. The upload was probably ` +
          'interrupted.',
      )
    }

    const actual = sha256(body)
    if (actual !== file.hash) {
      fail(
        `"${path}" downloaded corrupted.\n` +
          `  expected sha256 ${file.hash}\n  received sha256 ${actual}\n\n` +
          'Refusing to publish content that does not match the snapshot.',
      )
    }

    const target = targetFor(path, file, vault)
    await mkdir(dirname(target), { recursive: true })

    if (path.toLowerCase().endsWith('.md')) {
      const local = []
      const text = applyNoteMetadata(
        body.toString('utf8'),
        {
          title: file.title,
          /**
           * Three keys, not one list, and the splits are two different
           * arguments.
           *
           * `aliases` is separate because the *page* tells them apart: it is
           * printed on every note under "Also known as", and an old Obsidian
           * Publish URL (`About/How+to+Communicate`) is not a name anybody gave
           * the note.
           *
           * `oldUrls` and `renamedFrom` are separate because the *status* does:
           * an address publish.obsidian.md served is frozen and stays a 301,
           * and a rename this plugin recorded reverses the moment the note is
           * renamed back, so it is a 302. See `oldAddressesFor`.
           */
          aliases: file.aliases ?? [],
          ...oldAddressesFor(file, file.slug, redirects),
          /**
           * Where the plugin publishes this note, so a `permalink:` naming a
           * different address can be recognised as stale and dropped. Without
           * it a note set as the homepage is written to `index.md` and then
           * moved straight back out by its own frontmatter, because jotter
           * honours `permalink:` before anything claims the root. See
           * `applyNoteMetadata`.
           */
          servedAt: file.slug,
          /**
           * The dates the note would otherwise not have. Every fallback in
           * `src/lib/dates.ts` collapses on a vault written fresh by this
           * script (no frontmatter date, no git history, an mtime of *now*), so
           * without these every page reads as created on the day of the last
           * deploy. Skipped for any note that dates itself. See
           * `snapshotDates`.
           */
          ...snapshotDates(file),
        },
        local,
      )
      for (const message of local) warnings.push(`${path}: ${message}`)
      bodies.push(text)
      await writeFile(target, text, 'utf8')
    } else {
      await writeFile(target, body)
    }

    if (++done % 50 === 0 || done === entries.length) log(`${done}/${entries.length}`)
  })

  for (const message of warnings) warn(message)

  /**
   * The plugin resolved every link inside Obsidian, against the whole vault,
   * with the user's own settings: attachment folders, aliases, shortest-path
   * matching over notes that were never published. Nothing seeing only the
   * published subset can reproduce that, so jotter reads the answers instead of
   * guessing again.
   */
  const links = reKeyLinks(snapshot)
  if (Object.keys(links).length > 0) {
    await mkdir(join(vault, '.jotter'), { recursive: true })
    await writeFile(join(vault, '.jotter', 'links.json'), JSON.stringify({ links }, null, 2), 'utf8')
    log(`${Object.keys(links).length} note(s) of resolved links written to .jotter/links.json`)
  } else {
    // An empty index is not the same as no index: `parseLinksIndex` reports one
    // as unusable and warns on every build. A vault with no links between its
    // notes has nothing to short-circuit, so nothing is written.
    note('the snapshot resolved no links, so no .jotter/links.json was written')
  }

  /**
   * The posters and tweet text a click-to-play embed needs, fetched here
   * because this is already the step with a network and the built page must not
   * have one. Never fatal: everything it cannot fetch stays a link card, and
   * `src/markdown/wikilinks.ts` renders that without knowing why.
   */
  const embeds = await collectEmbeds(bodies, vault, note)
  if (Object.keys(embeds).length > 0) {
    await mkdir(join(vault, '.jotter'), { recursive: true })
    await writeFile(
      join(vault, '.jotter', 'embeds.json'),
      JSON.stringify({ embeds }, null, 2),
      'utf8',
    )
  }

  if (urlWarning) warn(urlWarning)
  if (url) log(`site URL ${url}`)

  const { options, notes, warnings: siteWarnings } = mapSite(snapshot.site, {
    url,
    folderNames: folderNamesFor(entries, snapshot.site?.folders),
    vault: vaultPath,
  })
  for (const message of notes) note(message)
  for (const message of siteWarnings) warn(message)

  await mkdir(join(ROOT, GENERATED_DIR), { recursive: true })
  await writeFile(OVERLAY_FILE, renderSiteJson(options, { snapshot: snapshot.id }), 'utf8')
  log(
    '.jotter/site.json was REGENERATED from the site options in Obsidian. ' +
      'jotter.config.ts is yours and was not touched.',
  )

  // Handed to finalize.mjs, which runs after the build has produced dist/.
  await writeFile(
    STATE_FILE,
    JSON.stringify({ snapshot: snapshot.id, noIndex: options.noIndex }, null, 2) + '\n',
    'utf8',
  )

  const notesWritten = entries.filter(([path]) => path.toLowerCase().endsWith('.md')).length
  log(
    `vault ready: ${notesWritten} note(s) and ${entries.length - notesWritten} attachment(s) ` +
      `in ${vault}`,
  )
}

main().catch((error) => fail(error.stack ?? String(error)))
