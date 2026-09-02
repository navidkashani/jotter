/**
 * The picture a link to this site unfurls as.
 *
 * `image:` has been declared in `src/content.config.ts` since the first commit
 * and read by nothing, so a vault that already carried the key (Obsidian users
 * write one, and Quartz reads one) got a text-only card and no warning. This
 * is the half of the answer that has a *right* answer: which file the author
 * meant, and whether an unfurler will draw it.
 *
 * Pure, DOM-free and `node:fs`-free, the rule `src/lib/analytics.ts` and
 * `src/lib/feed.ts` already state in their docstrings: vitest runs
 * `environment: 'node'` and there is no jsdom, so everything decidable lives
 * where a unit test can reach it. What is left in the layouts is markup.
 *
 * Split in two so the scan can validate a value without knowing the site URL:
 * `src/lib/vault.ts` warns at scan time, and `config.url` is not its business.
 */
import { assetHref } from './href.js'
import { resolveAsset, type VaultIndex } from './resolve.js'

/**
 * The spellings Quartz coalesces in `quartz/plugins/transformers/frontmatter.ts`
 * (`socialImage`, `image`, `cover`), so a vault that was published through
 * Quartz keeps its cards on the way over. jotter's own name is `image`, and it
 * wins, the way `aliases` wins over `alias`.
 */
const FRONTMATTER_KEYS = ['image', 'socialImage', 'cover'] as const

/**
 * The declared image, whichever of the three spellings the author used, and
 * *which* spelling, so a warning can quote the line they would go and edit
 * rather than a key they never typed.
 */
export function frontmatterImage(
  frontmatter: Record<string, unknown>,
): { key: string; value: string } | undefined {
  for (const key of FRONTMATTER_KEYS) {
    const value = frontmatter[key]
    if (typeof value === 'string' && value.trim()) return { key, value: value.trim() }
  }
  return undefined
}

/**
 * What an unfurler will actually draw, which is not the same question as
 * `isOptimizable` in `src/lib/embed.ts`: that one answers "what can Astro
 * re-encode". The lists overlap and are kept apart deliberately, for the same
 * reason `thirdPartyOrigins` names its two exemptions separately: one edit
 * should not widen both at once.
 *
 * SVG is the difference that bites. Facebook does not render it at all, and a
 * card that cannot draw is indistinguishable from no card while still costing
 * the reader's client a fetch. AVIF is left out for the same reason from the
 * other end: it is a format the crawlers are still catching up with.
 */
const DRAWABLE = /\.(png|jpe?g|gif|webp)$/i

export type SocialImage =
  /** `target` is a URL or a site-absolute path; `socialImageUrl` finishes it. */
  | { status: 'ok'; target: string; remote: boolean }
  /** Nothing was declared. Not a problem, and never warned about. */
  | { status: 'none' }
  /** Declared, and no such file in the vault. */
  | { status: 'unresolved' }
  /** Declared, found, and in a format no card will draw. */
  | { status: 'unsupported' }

/**
 * Resolve a declared `image:` against the vault, exactly the way an embed
 * resolves: `resolveAsset` already tries the normalized path, the note-relative
 * path and the bare filename, which is the whole of what Obsidian does. A hit
 * is served verbatim from `/_vault/` rather than through Astro's image
 * pipeline: the pipeline needs a static import Vite can see, which a dynamic
 * vault path does not give it, and its output is WebP/AVIF, thinner ground with
 * unfurlers than the author's own PNG.
 *
 * Two forms never touch the vault. A `//`, `http://` or `https://` URL is the
 * author naming somebody else's host on purpose; a leading `/` is how a file in
 * `public/` is named. Neither is format-checked: that is the author's explicit
 * choice, and a generated card endpoint has no extension to check.
 *
 * @param fromPath vault-relative path of the note that declared it, `''` for
 *                 `config.image`, which belongs to no note.
 */
export function resolveSocialImage(
  raw: unknown,
  fromPath: string,
  index: Pick<VaultIndex, 'assets'>,
): SocialImage {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { status: 'none' }

  if (/^(?:https?:)?\/\//i.test(value)) return { status: 'ok', target: value, remote: true }
  if (value.startsWith('/')) return { status: 'ok', target: value, remote: false }

  const asset = resolveAsset(value, fromPath, index)
  if (!asset) return { status: 'unresolved' }
  if (!DRAWABLE.test(asset)) return { status: 'unsupported' }
  return { status: 'ok', target: assetHref(asset), remote: false }
}

/**
 * The absolute URL to put in `og:image`, or nothing.
 *
 * Absolute is not a nicety: an unfurler has no document to resolve a relative
 * URL against, so a relative one is not a degraded card but a card nobody
 * draws. That is why the whole feature is gated on `config.url`, exactly as the
 * canonical link and the feed already are, and why this returns `undefined`
 * without one rather than emitting something shorter.
 */
export function socialImageUrl(
  resolved: SocialImage,
  siteUrl: string | undefined,
): string | undefined {
  if (resolved.status !== 'ok' || !siteUrl) return undefined
  try {
    return new URL(resolved.target, siteUrl).href
  } catch {
    return undefined
  }
}
