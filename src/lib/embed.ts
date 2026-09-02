/**
 * Obsidian's rule for the pipe in an embed: a value matching `^\d+(x\d+)?$` is
 * a *size*, anything else is a *caption*.
 *
 * Satteri hands the pipe value over as an image node's `alt`, which is why this
 * takes a string rather than a node: the same rule, whatever produced it.
 */

export interface EmbedPipe {
  width?: number
  height?: number
  caption?: string
}

const SIZE = /^(\d+)(?:x(\d+))?$/

export function parseEmbedPipe(pipe: string | undefined | null): EmbedPipe {
  const value = pipe?.trim()
  if (!value) return {}

  const size = SIZE.exec(value)
  if (!size) return { caption: value }

  return {
    width: Number(size[1]),
    ...(size[2] ? { height: Number(size[2]) } : {}),
  }
}

/**
 * Obsidian's *other* embed modifier, and the one the pipe above does not reach:
 * `![[Doc.pdf#page=3]]` and `![[Doc.pdf#height=400]]`, both documented at
 * obsidian.md/help/embeds. They are `#` fragment options, so they arrive inside
 * the target rather than beside it, and `parseEmbedPipe` never sees them.
 *
 * `height` is jotter's to apply, because it sizes the frame. Everything else is
 * handed on as the URL's own fragment, where the browser's PDF viewer already
 * reads `page` and means by it exactly what Obsidian means: honouring it costs
 * a string concatenation.
 */
export interface EmbedFragment {
  height?: number
  /** Ready to concatenate onto a URL: `#page=3`, or absent if nothing is left. */
  fragment?: string
}

const HEIGHT = /^height=(\d+)$/i

export function parseEmbedFragment(target: string): EmbedFragment {
  const hash = target.indexOf('#')
  if (hash === -1) return {}

  let height: number | undefined
  // `&` because that is how the PDF viewer's own parameters combine, which is
  // what the leftovers are about to become.
  const rest = target
    .slice(hash + 1)
    .split('&')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const match = HEIGHT.exec(part)
      if (!match) return true
      height = Number(match[1])
      return false
    })

  return {
    ...(height ? { height } : {}),
    ...(rest.length ? { fragment: `#${rest.join('&')}` } : {}),
  }
}

/**
 * What kind of thing an embed target is, by its extension.
 *
 * Obsidian dispatches on exactly this: `![[x.png]]` is a picture, `![[x.mp4]]`
 * a player, `![[x.pdf]]` a document, `![[Note]]` a transclusion. jotter used to
 * collapse the first three into an `<img>`, which is a broken image icon for
 * two of them: `<img src="Integrity.pdf">` renders in no browser.
 *
 * `undefined` means "not a file kind this knows", which for a local target is
 * a note to transclude and for a remote one is a page to link to.
 */
export type MediaKind = 'image' | 'video' | 'audio' | 'document'

const KINDS: ReadonlyArray<readonly [RegExp, MediaKind]> = [
  [/\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i, 'image'],
  [/\.(mp4|webm|ogv|mov)$/i, 'video'],
  [/\.(mp3|wav|m4a|ogg|flac)$/i, 'audio'],
  [/\.pdf$/i, 'document'],
]

/**
 * The query string is cut as well as the fragment, because this is asked of
 * remote URLs too: `![](https://twitter.com/user/status/123?s=4)` has no
 * extension either way, but `https://cdn.example.com/photo.png?v=2` is a
 * picture and a `#`-only split would miss it.
 */
export function mediaKind(target: string): MediaKind | undefined {
  const path = target.split('#')[0].split('?')[0].trim()
  return KINDS.find(([pattern]) => pattern.test(path))?.[1]
}

/** Targets Obsidian embeds as media rather than transcluding as a note. */
export const isMediaTarget = (target: string): boolean => mediaKind(target) !== undefined

/**
 * A remote URL Obsidian turns into a player or a card, recognised by its host
 * rather than by an extension.
 *
 * The extension table above is untouched on purpose: `mediaKind` answers "what
 * *file* is this", and none of these is a file. `https://youtu.be/dQw4w9WgXcQ`
 * has no extension, names no image, and is not a page to link to either: it is a
 * video, and a reader who sees a bare URL where Obsidian showed them a player
 * has been given a worse copy of their own note.
 *
 * What jotter does with the answer is the important half, and it does not
 * change the stance `README.md` sets out: **nothing third party is loaded**.
 * A recognised video becomes a facade with a locally-hosted poster, and the
 * player is fetched only when the reader clicks. The built HTML still contains
 * no request to anybody else's server, so the origin assertion in
 * `scripts/verify-build.mjs` keeps its meaning rather than gaining an exception.
 *
 * `undefined` for everything else, which stays a link card.
 */
export type RemoteKind = 'youtube' | 'vimeo' | 'tweet'

export interface RemoteEmbed {
  kind: RemoteKind
  /** Video, playlist or status id: what the facade needs to build a player. */
  id: string
  /** A playlist is `?list=`, not `?v=`, and the player URL differs. */
  playlist?: boolean
}

/** `youtu.be/<id>`, `youtube.com/watch?v=`, `/embed/`, `/shorts/`, `/playlist?list=`. */
const YOUTUBE_HOST = /^(?:www\.|m\.)?(?:youtube(?:-nocookie)?\.com|youtu\.be)$/i
const VIMEO_HOST = /^(?:www\.|player\.)?vimeo\.com$/i
const TWEET_HOST = /^(?:www\.|mobile\.)?(?:twitter\.com|x\.com)$/i

/** YouTube ids are 11 characters of the URL-safe base64 alphabet. */
const YOUTUBE_ID = /^[\w-]{11}$/
const NUMERIC_ID = /^\d+$/

export function remoteEmbed(target: string): RemoteEmbed | undefined {
  let url: URL
  try {
    // A protocol-relative URL is somebody else's host too, and `new URL` needs
    // a scheme to say so.
    url = new URL(target.startsWith('//') ? `https:${target}` : target)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined

  const path = url.pathname.replace(/\/+$/, '')
  const segments = path.split('/').filter(Boolean)

  if (YOUTUBE_HOST.test(url.host)) {
    const list = url.searchParams.get('list')
    // A playlist link with no video id plays the list; one with both plays the
    // video, which is what the reader clicked.
    const v = url.searchParams.get('v')
    if (v && YOUTUBE_ID.test(v)) return { kind: 'youtube', id: v }
    if (list) return { kind: 'youtube', id: list, playlist: true }
    // `youtu.be/<id>`, `/embed/<id>`, `/shorts/<id>`, `/live/<id>`.
    const last = segments.at(-1)
    if (last && YOUTUBE_ID.test(last)) return { kind: 'youtube', id: last }
    return undefined
  }

  if (VIMEO_HOST.test(url.host)) {
    // `vimeo.com/76979871` and `player.vimeo.com/video/76979871`.
    const last = segments.at(-1)
    return last && NUMERIC_ID.test(last) ? { kind: 'vimeo', id: last } : undefined
  }

  if (TWEET_HOST.test(url.host)) {
    // `/<handle>/status/<id>`, with `/statuses/` the older spelling.
    const at = segments.findIndex((s) => s === 'status' || s === 'statuses')
    const id = at === -1 ? undefined : segments[at + 1]
    return id && NUMERIC_ID.test(id) ? { kind: 'tweet', id } : undefined
  }

  return undefined
}

/**
 * The key `.jotter/embeds.json` files a fetched poster or tweet under.
 *
 * The URL as written is not usable: two notes citing one video with different
 * tracking parameters would be two entries, and neither would match the third
 * spelling. What identifies the thing is its kind and its id.
 */
export const embedKey = (embed: RemoteEmbed): string =>
  `${embed.kind}:${embed.playlist ? 'list:' : ''}${embed.id}`

/** The file's own name, which is what a document or download card is labelled. */
export function fileName(target: string): string {
  const path = target.split('#')[0].split('?')[0].trim()
  const base = path.split('/').pop() ?? path
  try {
    return decodeURIComponent(base)
  } catch {
    return base
  }
}

/** Images Astro must not attempt to re-encode. */
const UNOPTIMIZABLE = /\.(svg|gif)$/i
export const isOptimizable = (target: string): boolean =>
  /\.(png|jpe?g|webp|avif)$/i.test(target) && !UNOPTIMIZABLE.test(target)

/**
 * Intrinsic size of an SVG, from its `width`/`height` or its `viewBox`.
 *
 * Astro's image pipeline does not process SVG, so without this a passthrough
 * SVG would be the one image on the page with no reserved space, and layout
 * shift is exactly what the width/height build assertion exists to prevent.
 */
export function svgIntrinsicSize(source: string): { width: number; height: number } | undefined {
  const head = source.slice(0, 2000)
  const attr = (name: string) => {
    const match = new RegExp(`\\b${name}\\s*=\\s*["']([\\d.]+)(?:px)?["']`, 'i').exec(head)
    return match ? Number(match[1]) : undefined
  }

  const width = attr('width')
  const height = attr('height')
  if (width && height) return { width: Math.round(width), height: Math.round(height) }

  const viewBox = /\bviewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(head)
  if (!viewBox) return undefined
  return { width: Math.round(Number(viewBox[1])), height: Math.round(Number(viewBox[2])) }
}
