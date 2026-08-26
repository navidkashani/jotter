#!/usr/bin/env node
/**
 * Remove the build output and every cache Astro keeps.
 *
 * Clearing `node_modules/.astro` is the point of this command, not an
 * incidental part of it: the markdown pipeline caches rendered output there, so
 * a CSS or component edit can appear to do nothing until it is gone. Which is
 * also why this cannot simply spare the content store to stay safe — the store
 * and the cache are the same directory.
 *
 * So it refuses instead, while a dev server for this checkout is running. See
 * `scripts/lib/dev-server.mjs` for what goes wrong otherwise.
 *
 *   npm run clean              refuses while a dev server is running
 *   npm run clean -- --force   removes the caches anyway
 */
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { runningDevServers, devServerWarning } from './lib/dev-server.mjs'

const ROOT = join(import.meta.dirname, '..')
const FORCE = process.argv.includes('--force')

const TARGETS = ['dist', '.astro', 'node_modules/.astro', 'node_modules/.vite']

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
