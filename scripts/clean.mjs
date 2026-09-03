#!/usr/bin/env node
/**
 * Remove the build output and every cache Astro keeps.
 *
 * Clearing the content-collection stores is the point of this command, not an
 * incidental part of it: the markdown pipeline's rendered output is cached
 * there and invalidated on the *source file's* digest, so a plugin or config
 * edit can appear to do nothing until they are gone. There are two of them and
 * they are not interchangeable: `astro dev` uses `.astro/`, `astro build` uses
 * `node_modules/.astro/`. See `scripts/lib/astro-cache.mjs`.
 *
 * Which is also why this cannot simply spare the store to stay safe: the store
 * and the cache are the same directory. So it refuses instead, while a dev
 * server for this checkout is running. See `scripts/lib/dev-server.mjs` for
 * what goes wrong otherwise.
 *
 * It also removes `.jotter/`, everything an Open Publish build generates: the
 * fetched vault and the mapped site options. Nothing tracked is ever touched.
 *
 *   npm run clean              refuses while a dev server is running
 *   npm run clean -- --force   removes the caches anyway
 */
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { runningDevServers, devServerWarning } from './lib/dev-server.mjs'
import { CONTENT_STORES } from './lib/astro-cache.mjs'

const ROOT = join(import.meta.dirname, '..')
const FORCE = process.argv.includes('--force')

/**
 * `.jotter` is in here for a reason the other three do not have. It holds the
 * site options an Open Publish build mapped from Obsidian, and
 * `jotter.config.ts` reads them *in place of* its own literal. So a stale
 * overlay left behind from one experiment silently overrides the config a
 * developer is editing now, and the only symptom is a site that ignores every
 * change they make to it.
 */
const TARGETS = ['dist', '.jotter', ...CONTENT_STORES, 'node_modules/.vite']

if (!FORCE) {
  const servers = runningDevServers(ROOT)
  if (servers.length > 0) {
    const escape = ['npm run clean -- --force', 'remove the caches anyway']
    console.error(devServerWarning(servers, 'npm run clean', escape))
    process.exit(1)
  }
}

const removed = []
for (const target of TARGETS) {
  const path = join(ROOT, target)
  if (!(await stat(path).catch(() => null))) continue
  await rm(path, { recursive: true, force: true })
  removed.push(target)
}

console.log(removed.length > 0 ? `Removed ${removed.join(', ')}.` : 'Nothing to remove.')
