/**
 * `.jotter/embeds.json`: what a build with a network found out about the remote
 * things this vault embeds.
 *
 * The sibling of `.jotter/links.json`, and it exists for the same reason. That
 * file carries answers only something seeing the whole vault could compute;
 * this one carries answers only something with a network could fetch, and
 * jotter's own build deliberately has neither. `scripts/fetch-content.mjs`
 * writes it, because that script is already the one step of the pipeline that
 * talks to the internet.
 *
 * Two kinds of answer:
 *
 * - a **poster**, downloaded into the vault's attachments, so a video facade
 *   can show the frame the reader expects without asking `i.ytimg.com` for it.
 *   That last part is the whole point: `lite-youtube-embed` is the standard
 *   answer to this problem and it is not usable here, because it fetches its
 *   poster from YouTube at runtime, which is precisely the third-party request
 *   `scripts/verify-build.mjs` fails the build over.
 * - a **tweet**, as text and attribution rather than as markup. X's oEmbed
 *   endpoint returns a `<blockquote>`; storing the strings instead of the HTML
 *   means jotter renders its own markup, so there is nothing to sanitise and
 *   nothing of somebody else's styling to fight.
 *
 * Everything here is optional. No file, an unreadable one, or a key that is not
 * in it all mean the same thing: the facade renders without a poster and a
 * tweet renders as a link card. A missing embed must never be a failed build.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface EmbedRecord {
  /** Vault-relative path of the downloaded poster, e.g. `attachments/embeds/x.jpg`. */
  poster?: string
  /** Intrinsic size of that poster, so the facade reserves its space. */
  width?: number
  height?: number
  /** A tweet's text, flattened. */
  text?: string
  author?: string
  /** `@handle`, as written. */
  handle?: string
  /** The date the tweet's own permalink is labelled with. */
  date?: string
}

/** `embedKey()` -> what the build found. */
export type EmbedsFile = Record<string, EmbedRecord>

export interface EmbedIndex {
  lookup(key: string): EmbedRecord | undefined
  /** How many entries were loaded, for the build log. */
  size: number
}

const STRINGS = ['poster', 'text', 'author', 'handle', 'date'] as const
const NUMBERS = ['width', 'height'] as const

/** Parse an already-read index. Split out so it can be tested without a disk. */
export function parseEmbedsIndex(source: string, warnings: string[] = []): EmbedIndex | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    warnings.push(`.jotter/embeds.json is not valid JSON (${(error as Error).message}). Ignoring it.`)
    return undefined
  }

  // Accept either the bare map or an enveloped `{ embeds: {...} }`, exactly as
  // `parseLinksIndex` accepts both shapes of its own file.
  const raw =
    parsed && typeof parsed === 'object' && 'embeds' in parsed
      ? (parsed as { embeds: unknown }).embeds
      : parsed

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('.jotter/embeds.json is not an object of embed keys. Ignoring it.')
    return undefined
  }

  const entries = new Map<string, EmbedRecord>()
  for (const [key, value] of Object.entries(raw as EmbedsFile)) {
    if (!value || typeof value !== 'object') continue
    const record: EmbedRecord = {}
    for (const field of STRINGS) {
      const found = (value as Record<string, unknown>)[field]
      if (typeof found === 'string' && found.length > 0) record[field] = found
    }
    for (const field of NUMBERS) {
      const found = (value as Record<string, unknown>)[field]
      if (typeof found === 'number' && Number.isFinite(found) && found > 0) record[field] = found
    }
    // A record with nothing usable in it is the same as no record: keeping it
    // would make `lookup` answer "yes, and nothing", which no caller wants.
    if (Object.keys(record).length > 0) entries.set(key, record)
  }

  if (entries.size === 0) {
    warnings.push('.jotter/embeds.json contained no usable entries. Ignoring it.')
    return undefined
  }

  return { size: entries.size, lookup: (key) => entries.get(key) }
}

/** Load the index from a vault, if it has one. */
export function loadEmbedsIndex(vaultRoot: string, warnings: string[] = []): EmbedIndex | undefined {
  const file = join(vaultRoot, '.jotter', 'embeds.json')
  if (!existsSync(file)) return undefined
  try {
    return parseEmbedsIndex(readFileSync(file, 'utf8'), warnings)
  } catch (error) {
    warnings.push(`Could not read .jotter/embeds.json: ${(error as Error).message}. Ignoring it.`)
    return undefined
  }
}
