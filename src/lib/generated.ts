/**
 * The site options an Open Publish build wrote, or `null` when this is not one.
 *
 * ## Why this file exists at all
 *
 * `scripts/fetch-content.mjs` used to write `jotter.config.ts` itself, and that
 * file is tracked in git and named in the README as one a forker owns. So every
 * build rewrote a file the theme had just invited somebody to edit, the working
 * tree came back dirty, and the obvious next move (`git commit -a`) turned every
 * future upstream change to that path into a merge conflict. A theme that cannot
 * be updated is a theme that keeps whatever bugs it shipped with.
 *
 * So the generated half moved here, into `.jotter/`, which is git-ignored and
 * which nothing but the build writes. `jotter.config.ts` is now written once, by
 * a person, and never again by a machine.
 *
 * ## Replacement, not merge
 *
 * `jotter.config.ts` uses this as `generated ?? { …the literal… }`, and the `??`
 * is load-bearing. `mapSite` emits no `description`, `linkResolution`,
 * `publishGate` or `author`, because the plugin has no site option for any of
 * them, so a spread would leave the shipped demo's own description and title
 * sitting underneath a real person's site. An Open Publish build takes its
 * options *whole* from Obsidian; a hand-run build takes them whole from the
 * file. There is no third mode where half of each applies.
 *
 * ## Read at import, synchronously
 *
 * `astro.config.ts` imports `jotter.config.ts` at config load, before any async
 * work is possible, and `src/lib/vault.ts` already reads the vault the same way
 * and for the same reason. `process.cwd()` rather than `import.meta.url`,
 * matching `src/lib/site.ts`: this module is bundled by Vite, so by the time it
 * runs its own URL no longer points at the source tree.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { JotterConfigInput } from './config.js'

/** Written by `scripts/fetch-content.mjs`. Ignored by git, removed by `npm run clean`. */
const OVERLAY = resolve(process.cwd(), '.jotter', 'site.json')

export const generated: JotterConfigInput | null = read()

function read(): JotterConfigInput | null {
  let source: string
  try {
    source = readFileSync(OVERLAY, 'utf8')
  } catch {
    // No overlay. A plain markdown vault, built from the file in the repository.
    return null
  }

  /**
   * Present but unreadable is a build error rather than a silent fallback.
   *
   * Falling back here would publish the demo garden's title and description onto
   * somebody's real site, and the only symptom would be a site that looks wrong
   * to its owner and correct to every check in this repository. The file was
   * written seconds ago by the build; if it cannot be read, something is broken
   * that a person needs to hear about.
   */
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(
      `.jotter/site.json is not valid JSON (${(error as Error).message}).\n` +
        'It is written by scripts/fetch-content.mjs. Delete .jotter/ and build again.',
    )
  }

  const options = (parsed as { options?: unknown })?.options
  if (!options || typeof options !== 'object') {
    throw new Error(
      '.jotter/site.json has no `options` object.\n' +
        'It is written by scripts/fetch-content.mjs. Delete .jotter/ and build again.',
    )
  }

  return options as JotterConfigInput
}
