/**
 * Transclusion: `![[Note]]` inlines the target, `![[Note#Section]]` inlines one
 * section of it.
 *
 * Expansion happens *here*, in one synchronous pass over the raw markdown the
 * vault scan already holds, rather than by letting the engine re-enter the
 * plugin on spliced content. Doing it ourselves is what makes the depth limit
 * and the cycle guard enforceable: by the time anything reaches the parser
 * there are no `![[…]]` left in it, so there is nothing to recurse on.
 *
 * The same pass pre-resolves the transcluded note's own wikilinks against *its*
 * path, not the host's. A relative link inside a transcluded note has to mean
 * what it meant where it was written.
 */
import { protectedRanges, isProtected, anchorFor } from './protected.js'
import { resolveLink, resolveAsset, displayFor, splitTarget, type LinkResolution } from './resolve.js'
import { noteHref, assetHref } from './href.js'
import { slugifyHeading } from './slug.js'
import { isMediaTarget } from './embed.js'
import type { Vault, VaultNote } from './vault.js'

const WIKILINK = /(!?)\[\[([^[\]]+?)\]\]/g

export interface TranscludeOptions {
  maxDepth: number
  linkResolution: LinkResolution
}

export interface Transclusion {
  note: VaultNote
  /** Markdown, fully expanded, with wikilinks already resolved to hrefs. */
  markdown: string
  href: string
  title: string
  /** Set when the depth limit or a cycle stopped the expansion. */
  truncated?: 'depth' | 'cycle'
}

/**
 * One section of a note: from the named heading until the next heading of the
 * same or higher level. A block reference (`#^id`) resolves to the whole note,
 * which is v1's documented behaviour rather than a silent miss.
 */
export function sectionOf(body: string, subpath: string): string {
  if (!subpath || subpath.startsWith('#^')) return body

  const wanted = slugifyHeading(subpath.slice(1))
  const lines = body.split('\n')
  const ranges = protectedRanges(body)

  let offset = 0
  let startLine = -1
  let startLevel = 0

  for (let i = 0; i < lines.length; i++) {
    const heading = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[i])
    const protectedHere = isProtected(ranges, offset)
    offset += lines[i].length + 1

    if (!heading || protectedHere) continue
    const level = heading[1].length

    if (startLine === -1) {
      if (slugifyHeading(heading[2]) === wanted) {
        startLine = i
        startLevel = level
      }
    } else if (level <= startLevel) {
      return lines.slice(startLine + 1, i).join('\n').trim()
    }
  }

  return startLine === -1 ? '' : lines.slice(startLine + 1).join('\n').trim()
}

/**
 * Rewrite a note's wikilinks into markdown links resolved against its own path.
 * Unresolved and unpublished targets become plain text, never a dead `<a>`.
 */
export function preresolveLinks(body: string, fromPath: string, vault: Vault, mode: LinkResolution): string {
  const ranges = protectedRanges(body)

  return body.replace(WIKILINK, (match, bang: string, inner: string, index: number) => {
    if (isProtected(ranges, index)) return match

    const pipe = inner.indexOf('|')
    const rawTarget = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
    const alias = pipe === -1 ? undefined : inner.slice(pipe + 1).trim()
    if (!rawTarget || rawTarget.startsWith('#')) return match

    if (bang === '!' && isMediaTarget(rawTarget)) {
      const asset = resolveAsset(rawTarget, fromPath, vault)
      return asset ? `![${alias ?? ''}](${assetHref(asset)})` : displayFor(rawTarget, alias)
    }

    const resolution = resolveLink(rawTarget, fromPath, vault, mode)
    const label = displayFor(rawTarget, alias)
    if (resolution.status !== 'published') return label

    const { subpath } = splitTarget(rawTarget)
    return `[${label}](${noteHref(resolution.note.slug, subpath)})`
  })
}

/**
 * Expand every note embed in `body`, depth-first.
 *
 * @param stack slugs currently being expanded, innermost last. A target already
 *              on the stack is a cycle and stops there.
 */
export function expandTransclusions(
  body: string,
  fromPath: string,
  vault: Vault,
  options: TranscludeOptions,
  stack: readonly string[] = [],
): string {
  const ranges = protectedRanges(body)

  return body.replace(WIKILINK, (match, bang: string, inner: string, index: number) => {
    if (bang !== '!' || isProtected(ranges, index)) return match

    const pipe = inner.indexOf('|')
    const rawTarget = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
    if (!rawTarget || isMediaTarget(rawTarget)) return match

    const resolution = resolveLink(rawTarget, fromPath, vault, options.linkResolution)
    if (resolution.status !== 'published') return displayFor(rawTarget)

    const target = resolution.note
    if (stack.includes(target.slug)) return calloutFor('cycle', target.title, target.slug)
    if (stack.length >= options.maxDepth) return calloutFor('depth', target.title, target.slug)

    const { subpath } = splitTarget(rawTarget)
    const section = sectionOf(target.body, subpath)
    const expanded = expandTransclusions(section, target.path, vault, options, [...stack, target.slug])
    const resolved = preresolveLinks(expanded, target.path, vault, options.linkResolution)

    return wrap(resolved, target.title, noteHref(target.slug, subpath))
  })
}

/**
 * The transcluded body, as a block that always links back to its source. Blank
 * lines around the content matter: they end the HTML block so CommonMark parses
 * what is between the tags as markdown rather than as more raw HTML.
 */
function wrap(markdown: string, title: string, href: string): string {
  const body = markdown.trim() || '_This note is empty._'
  return [
    '',
    `<aside class="transclusion" data-transclusion>`,
    '',
    body,
    '',
    `<a class="transclusion-source" href="${href}">${escapeHtml(title)}</a>`,
    '',
    '</aside>',
    '',
  ].join('\n')
}

function calloutFor(reason: 'cycle' | 'depth', title: string, slug: string): string {
  const message =
    reason === 'cycle'
      ? `This note is already open above, so it is linked rather than inlined.`
      : `Transclusion nested too deeply, so it is linked rather than inlined.`
  return [
    '',
    `<aside class="transclusion transclusion-stopped" data-transclusion="${reason}">`,
    '',
    `${message} [${escapeHtml(title)}](${noteHref(slug)})`,
    '',
    '</aside>',
    '',
  ].join('\n')
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export { anchorFor }
