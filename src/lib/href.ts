/**
 * Every URL the site emits is built here, so there is one answer to "what does
 * a link to this note look like" and one place to change it.
 */
import { anchorFor } from './protected.js'

/** Where vault attachments are served from, in dev and in `dist/`. */
export const VAULT_ASSET_BASE = '/_vault'

const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, '')

/** Percent-encode each segment, leaving the separators readable. */
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

export function noteHref(slug: string, subpath = '', base = ''): string {
  const prefix = base ? `/${trimSlashes(base)}` : ''
  const clean = trimSlashes(slug)
  // `index` is the site root, not `/index`.
  const path = clean === 'index' ? '' : `/${encodePath(clean)}`
  return `${prefix}${path || '/'}${anchorFor(subpath)}`
}

export function assetHref(vaultPath: string, base = ''): string {
  const prefix = base ? `/${trimSlashes(base)}` : ''
  return `${prefix}${VAULT_ASSET_BASE}/${encodePath(trimSlashes(vaultPath))}`
}

export function tagHref(tag: string, base = ''): string {
  const prefix = base ? `/${trimSlashes(base)}` : ''
  return `${prefix}/tags/${encodePath(trimSlashes(tag))}`
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
