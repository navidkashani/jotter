/**
 * Date precedence: frontmatter -> git -> filesystem mtime.
 *
 * Every step is a fallback, never a requirement: a vault of bare markdown must
 * render. git is consulted once per build for the whole vault rather than once
 * per note; spawning `git log` 1,000 times is the difference between a 6s build
 * and a 90s one.
 */
import { execFileSync } from 'node:child_process'

export interface NoteDates {
  created: Date
  updated: Date
}

const asDate = (value: unknown): Date | undefined => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'number') return new Date(value)
  if (typeof value === 'string') {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d
  }
  return undefined
}

/**
 * Five spellings each, because five is what real vaults contain.
 *
 * Exported so a test can assert that every one of them is declared in
 * `src/lib/frontmatter.ts` — the same reason `analyticsProviders` is exported
 * from `src/lib/config.ts`. A spelling read here but undeclared there worked
 * only by accident of `.passthrough()`, which is not the same thing as working
 * on purpose.
 */
export const FRONTMATTER_CREATED = ['created', 'date', 'created_at', 'createdAt', 'published']
export const FRONTMATTER_UPDATED = ['updated', 'modified', 'updated_at', 'updatedAt', 'lastmod']

export function frontmatterDate(
  frontmatter: Record<string, unknown>,
  keys: readonly string[],
): Date | undefined {
  for (const key of keys) {
    const parsed = asDate(frontmatter[key])
    if (parsed) return parsed
  }
  return undefined
}

/**
 * First and last commit time per file, in one `git log` pass over the vault.
 * Returns an empty map outside a repository: not an error, since most people
 * fork a template and point it at a folder that was never committed.
 */
export function gitDates(cwd: string): Map<string, { created: Date; updated: Date }> {
  const dates = new Map<string, { created: Date; updated: Date }>()
  let out: string
  try {
    out = execFileSync('git', ['log', '--name-only', '--pretty=format:%x00%ct', '--', '.'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return dates
  }

  // `git log` is newest-first, so the first time we see a file is its update
  // time and the last is its creation time.
  let timestamp = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('\0')) {
      timestamp = Number(line.slice(1)) * 1000
      continue
    }
    const file = line.trim()
    if (!file || !timestamp) continue
    const existing = dates.get(file)
    if (existing) existing.created = new Date(timestamp)
    else dates.set(file, { created: new Date(timestamp), updated: new Date(timestamp) })
  }
  return dates
}

export function resolveDates(
  frontmatter: Record<string, unknown>,
  git: { created: Date; updated: Date } | undefined,
  mtime: Date,
): NoteDates {
  const created = frontmatterDate(frontmatter, FRONTMATTER_CREATED) ?? git?.created ?? mtime
  const updated = frontmatterDate(frontmatter, FRONTMATTER_UPDATED) ?? git?.updated ?? mtime
  // A note edited before it was created is a data error, not something to render.
  return { created, updated: updated < created ? created : updated }
}
