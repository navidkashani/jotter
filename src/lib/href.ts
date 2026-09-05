/**
 * Every URL the site emits is built here, so there is one answer to "what does
 * a link to this note look like" and one place to change it.
 *
 * The encoding itself is `encodeSlug` in `src/lib/url.ts`, and every other
 * producer of a page's URL (canonical, `og:url`, the sitemap, a search result)
 * calls the same function: a link and a canonical that spell the same page
 * differently are two pages as far as a crawler is concerned.
 */
import { anchorFor } from './protected.js'
import { encodeSlug } from './url.js'

/** Where vault attachments are served from, in dev and in `dist/`. */
export const VAULT_ASSET_BASE = '/_vault'

const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, '')

export function noteHref(slug: string, subpath = '', base = ''): string {
  const prefix = base ? `/${trimSlashes(base)}` : ''
  const clean = trimSlashes(slug)
  // `index` is the site root, not `/index`.
  const path = clean === 'index' ? '' : `/${encodeSlug(clean)}`
  return `${prefix}${path || '/'}${anchorFor(subpath)}`
}

export function assetHref(vaultPath: string, base = ''): string {
  const prefix = base ? `/${trimSlashes(base)}` : ''
  return `${prefix}${VAULT_ASSET_BASE}/${encodeSlug(trimSlashes(vaultPath))}`
}

/**
 * The all-notes listing. Takes its slug because the slug is not a constant: a
 * vault folder called `Notes/` claims `/notes` first, and then the listing is
 * somewhere else. `src/lib/site.ts` resolves which and exports `allNotesSlug`.
 *
 * A named function for a URL that is only ever one link deep, because the
 * literal `/notes` in `Header.astro` is precisely how the collision went
 * unnoticed: the page moved and the header went on pointing at the old address.
 */
export function allNotesHref(slug: string, base = ''): string {
  return noteHref(slug, '', base)
}

export function tagHref(tag: string, base = ''): string {
  const prefix = base ? `/${trimSlashes(base)}` : ''
  return `${prefix}/tags/${encodeSlug(trimSlashes(tag))}`
}

/**
 * An asset path relative to the note embedding it, which is what Astro's image
 * pipeline needs in order to optimize it. Astro resolves relative markdown
 * image sources against the file, so `../attachments/x.png` from
 * `notes/Note.md` gets intrinsic dimensions and AVIF/WebP for free; an absolute
 * `/_vault/...` URL would be copied through untouched.
 */
export function relativeAssetPath(fromPath: string, assetPath: string): string {
  const from = fromPath.split('/').slice(0, -1)
  const to = assetPath.split('/')
  let shared = 0
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++

  const up = Array(from.length - shared).fill('..')
  const down = to.slice(shared)
  const path = [...up, ...down].join('/')
  return path.startsWith('.') ? path : `./${path}`
}
