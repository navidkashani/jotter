/**
 * Is a dev server running against *this* checkout?
 *
 * Asked before anything deletes the content-collection stores. The one a live
 * server is reading is `.astro/data-store.json` — *not* `node_modules/.astro`,
 * which is the build store and which a dev server never opens. Astro picks
 * between them on `isDev`; `lib/astro-cache.mjs` has the citation.
 *
 * `data-store.json` is not a cache a running server rebuilds lazily — it *is*
 * what `getCollection()` reads. Remove it underneath a live `astro dev` and the
 * next request for a note throws `[jotter] No collection entry for …` from
 * `src/pages/[...slug].astro`. That throw is working as designed; the data
 * really is gone. It is just that nothing in the message points at the command
 * that caused it.
 *
 * Detection is a process scan rather than `astro dev status` for two reasons:
 * it costs a few milliseconds instead of spawning npx, and it sees a
 * foreground `astro dev` in another terminal as well as the managed one this
 * Astro version daemonises by default.
 *
 * The match is scoped to this project's own `astro.mjs`, so a dev server for a
 * different repository is correctly ignored — it reads its own `.astro`, which
 * nothing here touches.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * @param {string} root Absolute path to the project root.
 * @returns {{ pid: number, command: string }[]} Empty when none, and empty on
 *   any platform where `ps` is unavailable — a missing guard must never be the
 *   reason a clean fails.
 */
export function runningDevServers(root) {
  const binary = join(root, 'node_modules', 'astro', 'bin', 'astro.mjs')

  let out
  try {
    out = execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' })
  } catch {
    return []
  }

  const found = []
  for (const line of out.split('\n')) {
    if (!line.includes(binary) || !/\bdev\b/.test(line.slice(line.indexOf(binary)))) continue
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match) found.push({ pid: Number(match[1]), command: match[2].trim() })
  }
  return found
}

/**
 * The refusal, worded once so `clean` and `verify --full` say the same thing.
 *
 * `escape` is per-caller because only one of them has an override: `clean`
 * takes `--force`, while `verify --full` has nothing to offer but stopping the
 * server, and printing a flag that does not exist would be worse than printing
 * nothing.
 */
export function devServerWarning(servers, what, escape) {
  const pids = servers.map((s) => `pid ${s.pid}`).join(', ')
  return [
    `A dev server for this project is running (${pids}).`,
    '',
    `${what} removes .astro, which holds the content-collection store that`,
    'server is reading. Deleting it now would make the next request for a note',
    'fail with "[jotter] No collection entry for …" until the server is',
    'restarted.',
    '',
    ...[
      ['npx astro dev stop', 'stop it, then run this again'],
      ...(escape ? [escape] : []),
    ].map(([command, why]) => `  ${command.padEnd(26)}${why}`),
  ].join('\n')
}
