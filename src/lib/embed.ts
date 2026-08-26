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

/** Extensions Obsidian embeds as media rather than transcluding as a note. */
const MEDIA = /\.(png|jpe?g|gif|webp|avif|svg|bmp|mp4|webm|ogv|mov|mp3|wav|m4a|ogg|flac|pdf)$/i

export const isMediaTarget = (target: string): boolean => MEDIA.test(target.split('#')[0].trim())

/** Images Astro must not attempt to re-encode. */
const UNOPTIMIZABLE = /\.(svg|gif)$/i
export const isOptimizable = (target: string): boolean =>
  /\.(png|jpe?g|webp|avif)$/i.test(target) && !UNOPTIMIZABLE.test(target)

/**
 * Intrinsic size of an SVG, from its `width`/`height` or its `viewBox`.
 *
 * Astro's image pipeline does not process SVG, so without this a passthrough
 * SVG would be the one image on the page with no reserved space — and layout
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
