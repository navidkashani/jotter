/**
 * Wikilink and embed resolution.
 *
 * Three outcomes per link, matching Quartz's `CrawlLinks` and the mockup:
 *   published    -> a real `<a>`
 *   unpublished  -> an inert `<span class="dead-link">`
 *   unresolved   -> an inert `<span class="dead-link">`
 *
 * A dead link is a `<span>` and not an `<a href="">` because a link that goes
 * nowhere is worse than no link: it takes focus, it takes a click, and it lies.
 *
 * The privacy rule: a dead link never renders an unpublished note's *title*.
 * When the author wrote an alias we show the alias; otherwise we show the
 * basename of the target they typed. `My Very Private Title` stays in the vault.
 */
import { resolveLink, resolveAsset, displayFor, liveLabel, splitTarget } from '../lib/resolve.js'
import { parseEmbedPipe, isMediaTarget, isOptimizable } from '../lib/embed.js'
import { noteHref, assetHref, relativeAssetPath } from '../lib/href.js'
import { anchorFor } from '../lib/protected.js'
import { previewFor } from '../lib/preview.js'
import type { VaultNote } from '../lib/vault.js'
import {
  isWikiSyntax,
  wikiPipe,
  type DocumentContext,
  type VisitorContext,
  type Positioned,
} from './context.js'

interface LinkNode extends Positioned {
  type: 'link'
  url: string
  children?: unknown[]
  /** Set by an earlier plugin: an inline transclusion arrives wearing a class. */
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>
}

interface ImageNode extends Positioned {
  type: 'image'
  url: string
  alt?: string | null
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i

/** Mark a node inert. `href: null` stops the link->hast step emitting an href. */
const deadLink = (ctx: VisitorContext, node: unknown, label?: string) => {
  ctx.setProperty(node, 'data', {
    hName: 'span',
    hProperties: { className: ['dead-link'], href: null, title: null },
  })
  if (label !== undefined) ctx.setProperty(node, 'children', [{ type: 'text', value: label }])
}

/**
 * Where an embedded asset should point. Optimizable rasters get a note-relative
 * path so Astro's image pipeline can process them; everything else (SVG, GIF,
 * video, PDF) is served verbatim from the vault mount.
 */
export function embedSrc(assetPath: string, fromPath: string, mode: 'optimize' | 'passthrough'): string {
  return mode === 'optimize' && isOptimizable(assetPath)
    ? relativeAssetPath(fromPath, assetPath)
    : assetHref(assetPath)
}

interface Embed {
  assetPath?: string
  width?: number
  height?: number
}

/**
 * Explicit dimensions for an embed: the author's pipe when they gave one, else
 * the asset's intrinsic size where jotter knows it. Astro fills these in for
 * the formats it processes; this covers the ones it passes through.
 */
function embedSize(embed: Embed, vault: DocumentContext['vault']) {
  if (embed.width) {
    return { width: embed.width, ...(embed.height ? { height: embed.height } : {}) }
  }
  const intrinsic = embed.assetPath ? vault.assetSizes.get(embed.assetPath) : undefined
  return intrinsic ? { width: intrinsic.width, height: intrinsic.height } : undefined
}

export function wikilinks(doc: DocumentContext) {
  const { vault, config, fromPath } = doc
  const previews = config.features.hoverPreview

  /**
   * The two attributes `src/scripts/hover-preview.ts` reads. Same route
   * `deadLink` above uses, minus the `hName` override — the node stays an `<a>`
   * and simply gains attributes.
   *
   * Emitted only with the flag on, so the bytes are absent rather than hidden,
   * and only when there is something to show: an anchor with a blank card is
   * worse than an anchor with none.
   *
   * Merged into whatever `hProperties` the node already carries. An inline
   * transclusion reaches this visitor as a `link` that is already wearing a
   * class, and overwriting `data` would strip it.
   */
  const attachPreview = (node: LinkNode, ctx: VisitorContext, note: VaultNote, subpath: string) => {
    const preview = previewFor(note, subpath)
    if (!preview) return
    ctx.setProperty(node, 'data', {
      ...node.data,
      hProperties: {
        ...node.data?.hProperties,
        'data-preview-title': preview.title,
        'data-preview': preview.text,
      },
    })
  }

  /**
   * An internal absolute href, back to the note it points at.
   *
   * Not a nicety — without it the feature looks broken on exactly the notes it
   * should look best on. `preresolveLinks` rewrites every wikilink inside
   * transcluded content into `[label](/slug#anchor)` *before* the host note is
   * parsed, so by the time this visitor sees one there is no `[[…]]` left and
   * the `EXTERNAL` guard — whose pattern matches a leading `/` — would return
   * without a second look. Hand-written `[x](/zettelkasten)` links get previews
   * out of the same branch, which is right rather than incidental.
   */
  const noteForHref = (url: string): { note: VaultNote; subpath: string } | undefined => {
    const hash = url.indexOf('#')
    const path = hash === -1 ? url : url.slice(0, hash)
    let slug: string
    try {
      // The mirror of `noteHref`: it encodes each segment, and spells the
      // site root `/` rather than `/index`.
      slug = path === '/' ? 'index' : path.slice(1).split('/').map(decodeURIComponent).join('/')
    } catch {
      return undefined // A malformed escape is not ours to repair.
    }
    const note = vault.bySlug.get(slug)
    return note?.published ? { note, subpath: hash === -1 ? '' : url.slice(hash) } : undefined
  }

  /** Shared by the `image` visitor and the lone-image `paragraph` visitor. */
  const describeEmbed = (node: ImageNode, ctx: VisitorContext) => {
    const wiki = isWikiSyntax(node, ctx)
    const target = node.url
    if (!wiki && EXTERNAL.test(target)) return undefined

    // Only a wikilink embed carries Obsidian's pipe rule; a markdown image's
    // `alt` is just alt text.
    const pipe = wiki ? wikiPipe(node, ctx) : undefined
    const { width, height, caption } = parseEmbedPipe(pipe)

    const assetPath = resolveAsset(target, fromPath, vault)
    const alt = caption ?? (wiki ? displayFor(target) : (node.alt ?? ''))
    return { wiki, target, assetPath, width, height, caption, alt }
  }

  return {
    name: 'jotter:wikilinks',
    options: { position: true },

    link(node: LinkNode, ctx: VisitorContext) {
      const wiki = isWikiSyntax(node, ctx)
      if (!wiki && EXTERNAL.test(node.url)) {
        // `EXTERNAL` lumps internal absolute hrefs in with genuinely external
        // ones. A single leading slash is ours; `//host` is not.
        if (previews && node.url.startsWith('/') && !node.url.startsWith('//')) {
          const target = noteForHref(node.url)
          if (target) attachPreview(node, ctx, target.note, target.subpath)
        }
        return
      }

      const resolution = resolveLink(node.url, fromPath, vault, config.linkResolution)
      const alias = wiki ? wikiPipe(node, ctx) : undefined

      if (resolution.status === 'published') {
        ctx.setProperty(node, 'url', noteHref(resolution.note.slug, resolution.anchor))
        if (previews) attachPreview(node, ctx, resolution.note, resolution.anchor)
        // Without a pipe, Satteri labels the link with the raw target, so
        // `[[Note#Heading]]` would read "Note#Heading". Obsidian spells that
        // separator `>`.
        if (wiki && alias === undefined) {
          ctx.setProperty(node, 'children', [{ type: 'text', value: liveLabel(node.url) }])
        }
        return
      }

      // A relative markdown link may point at an attachment rather than a note.
      if (!wiki) {
        const asset = resolveAsset(node.url, fromPath, vault)
        if (asset) {
          ctx.setProperty(node, 'url', assetHref(asset))
          return
        }
      }

      // Dead. Relabel only when the author gave no alias: with a pipe, the
      // children already hold their label and may carry formatting we should
      // not flatten into a string.
      const hasAlias = wiki ? alias !== undefined : true
      deadLink(ctx, node, hasAlias ? undefined : displayFor(node.url))
    },

    image(node: ImageNode, ctx: VisitorContext) {
      const embed = describeEmbed(node, ctx)
      if (!embed) return

      // A note embed is a transclusion, which the transclude plugin owns.
      if (embed.wiki && !isMediaTarget(embed.target)) return

      // A lone captioned embed becomes a figure in the paragraph visitor
      // below; letting both fire would queue two transforms on one subtree.
      if (embed.caption) {
        const parent = ctx.parent(node)
        if (parent?.type === 'paragraph' && parent.children?.length === 1) return
      }

      if (!embed.assetPath) {
        ctx.replaceNode(node, {
          type: 'missingEmbed',
          data: { hName: 'span', hProperties: { className: ['dead-link', 'dead-embed'] } },
          children: [{ type: 'text', value: displayFor(embed.target) }],
        })
        ctx.report({
          message: `Embedded file not found: "${embed.target}" in ${fromPath}`,
          severity: 'warning',
        })
        return
      }

      ctx.setProperty(node, 'url', embedSrc(embed.assetPath, fromPath, config.images))
      // A numeric pipe is a size, not alt text: Satteri puts the pipe value in
      // `alt` either way, so `![[x.png|320]]` would otherwise read as "320".
      ctx.setProperty(node, 'alt', embed.alt)

      const size = embedSize(embed, vault)
      if (size) ctx.setProperty(node, 'data', { hProperties: size })
    },

    /**
     * A lone embed in its own paragraph becomes a `<figure>`. It has to happen
     * at the paragraph, not the image: `<figure>` inside `<p>` is invalid
     * nesting, and Astro 7's compiler no longer quietly corrects it.
     */
    paragraph(node: { children?: unknown[] } & Positioned, ctx: VisitorContext) {
      const children = node.children ?? []
      if (children.length !== 1) return

      const only = children[0] as ImageNode
      if (only?.type !== 'image') return

      const embed = describeEmbed(only, ctx)
      if (!embed?.assetPath || !embed.caption) return
      if (embed.wiki && !isMediaTarget(embed.target)) return

      ctx.replaceNode(node, {
        type: 'figure',
        data: { hName: 'figure', hProperties: { className: ['embed-figure'] } },
        children: [
          {
            type: 'image',
            url: embedSrc(embed.assetPath, fromPath, config.images),
            alt: embed.alt,
            ...((size) => (size ? { data: { hProperties: size } } : {}))(embedSize(embed, vault)),
          },
          {
            type: 'figcaption',
            data: { hName: 'figcaption' },
            children: [{ type: 'text', value: embed.caption }],
          },
        ],
      })
    },
  }
}

/** Exported for tests: the label a dead link should carry. */
export const deadLinkLabel = (target: string, alias?: string): string => displayFor(target, alias)

/** Exported for tests: the href a resolved link should carry. */
export const resolvedHref = (slug: string, subpath: string): string => noteHref(slug, subpath)

export { splitTarget, anchorFor }
