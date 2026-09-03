#!/usr/bin/env node
/**
 * The last step of a build from Open Publish: tell the plugin the snapshot is
 * live, and tell the CDN not to cache that answer.
 *
 * It runs **after** `astro build` (a generator clears its output directory,
 * so anything written before it would be deleted), and after
 * `scripts/verify-build.mjs`, which is the ordering that matters here. A build
 * that failed jotter's own gate never gets a `_publish.json`, so the plugin
 * cannot report a broken deploy as the live one; it keeps polling and then
 * times out, which is the truth.
 *
 * It exits 0 having done nothing when `.op-build-state.json` is absent, so a
 * site that is not fed by a snapshot is untouched.
 *
 * ## What it does not write
 *
 * `robots.txt`: `src/integrations/vault.ts` already writes it on every build,
 * from `robotsTxt(noIndex)`, whose noIndex output is byte-identical to the
 * reference implementation's. And `_redirects`: old addresses arrive as
 * `aliases:` in each note's frontmatter, so `buildRedirects` has already
 * emitted them, in URL space, through the same encoder every other link in the
 * site went through. There is nothing left here to merge, and so no way for a
 * merge to go wrong.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

/** cwd-relative, for the reason `fetch-content.mjs` gives at the same place. */
const ROOT = process.cwd()
const STATE_FILE = join(ROOT, '.op-build-state.json')
const DIST = join(ROOT, 'dist')

/**
 * Which jotter built this site, read off `package.json` rather than written
 * here, so a release bumps one number in one file.
 *
 * The reason it goes on the wire at all: a site made from this repository is a
 * *copy*, and a copy has no link back. When jotter fixes something, nothing
 * tells the person running it, and nothing ever will unless the site says which
 * version it is. The plugin already fetches this file on every publish
 * (`plugin/src/builders/webhook.ts`), so this is the one channel that exists,
 * costs nothing and reaches every deployed site. See `docs/updating.md`.
 *
 * Never fatal. A missing or unreadable `package.json` means the marker goes out
 * without the field, which is exactly what an older starter's marker looks like,
 * and the plugin already has to handle that.
 */
async function starter() {
  try {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
    if (typeof pkg?.name !== 'string' || typeof pkg?.version !== 'string') return undefined
    return { name: pkg.name, version: pkg.version }
  } catch {
    return undefined
  }
}

const log = (message) => console.log(`[open-publish] ${message}`)

function fail(message) {
  console.error(`\n[open-publish] Build stopped.\n\n${message}\n`)
  process.exit(1)
}

async function main() {
  let state
  try {
    state = JSON.parse(await readFile(STATE_FILE, 'utf8'))
  } catch {
    // Not an Open Publish build. Nothing to finalize.
    return
  }

  if (!state?.snapshot) {
    fail(
      `${STATE_FILE} exists but names no snapshot.\n` +
        'Delete it and run scripts/fetch-content.mjs again.',
    )
  }

  /**
   * The marker the plugin polls, every 3 to 15 seconds for ten minutes
   * (`plugin/src/builders/webhook.ts`), to know that the snapshot it just
   * pushed is the one being served. Without it every publish ends in "still
   * waiting" on a site that went live minutes earlier.
   *
   * `starter` rides along on the same request. It is not needed to answer "is
   * my publish live", which is what the poll is for; it answers the question
   * nothing else can reach a deployed site to ask, which is "is the theme this
   * site runs the current one".
   */
  const running = await starter()

  try {
    await writeFile(
      join(DIST, '_publish.json'),
      JSON.stringify(
        { snapshot: state.snapshot, builtAt: Date.now(), ...(running ? { starter: running } : {}) },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  } catch (error) {
    fail(
      `Could not write dist/_publish.json (${error.message}).\n` +
        'Without it the plugin polls for ten minutes and then reports a publish that ' +
        "already succeeded as a timeout. Check the build log above for the build's own error.",
    )
  }

  /**
   * `no-store` on the marker, because a CDN serving a cached one would have the
   * plugin report a stale snapshot as live: the wrong direction to be wrong
   * in. `X-Robots-Tag` is the half of `noIndex` that `robots.txt` cannot do:
   * it reaches a crawler that arrived at a page directly. Both are requests
   * rather than access control; see the plugin's `docs/security.md`.
   */
  const rules = [
    '/_publish.json',
    '  Cache-Control: no-store',
    '  Content-Type: application/json',
  ]
  if (state.noIndex) {
    rules.push('/*', '  X-Robots-Tag: noindex, nofollow')
    log('search engines asked not to index this site')
  }

  // jotter writes no `_headers` of its own today. Merged rather than
  // overwritten anyway, so the day it does (or the day a forker adds one)
  // this appends to it instead of deleting it.
  const existing = await readFile(join(DIST, '_headers'), 'utf8').catch(() => '')
  const merged = existing.trim() ? `${existing.trimEnd()}\n\n${rules.join('\n')}\n` : `${rules.join('\n')}\n`
  await writeFile(join(DIST, '_headers'), merged, 'utf8')

  log(
    running
      ? `published snapshot ${state.snapshot} on ${running.name} ${running.version}`
      : `published snapshot ${state.snapshot}`,
  )
}

main().catch((error) => fail(error.stack ?? String(error)))
