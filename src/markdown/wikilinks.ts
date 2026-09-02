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
import {
  parseEmbedPipe,
  parseEmbedFragment,
  isMediaTarget,
  isOptimizable,
  mediaKind,
  fileName,
  type MediaKind,
} from '../lib/embed.js'
import { noteHref, assetHref, relativeAssetPath } from '../lib/href.js'
import { decodeSlug } from '../lib/url.js'
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

/**
 * An embed target on somebody else's origin. A single leading slash is ours and
 * a `data:` URI is nobody's, so both are left exactly as the author wrote them.
 */
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i

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

/** What the embed visitors need to know about one `![[…]]` or `![](…)`. */
interface DescribedEmbed extends Embed {
  wiki: boolean
  remote: boolean
  target: string
  kind: MediaKind | undefined
  caption?: string
  alt: string
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
   * `deadLink` above uses, minus the `hName` override: the node stays an `<a>`
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
   * Not a nicety: without it the feature looks broken on exactly the notes it
   * should look best on. `preresolveLinks` rewrites every wikilink inside
   * transcluded content into `[label](/slug#anchor)` *before* the host note is
   * parsed, so by the time this visitor sees one there is no `[[…]]` left and
   * the `EXTERNAL` guard (whose pattern matches a leading `/`) would return
   * without a second look. Hand-written `[x](/zettelkasten)` links get previews
   * out of the same branch, which is right rather than incidental.
   */
  const noteForHref = (url: string): { note: VaultNote; subpath: string } | undefined => {
    const hash = url.indexOf('#')
    const path = hash === -1 ? url : url.slice(0, hash)
    // `decodeSlug` is the mirror of the encoder `noteHref` uses; the one thing
    // it does not know is that jotter spells the site root `/` rather than
    // `/index`, which is this line.
    const slug = path === '/' ? 'index' : decodeSlug(path.slice(1))
    const note = vault.bySlug.get(slug)
    return note?.published ? { note, subpath: hash === -1 ? '' : url.slice(hash) } : undefined
  }

  /** Shared by the `image` visitor and the lone-image `paragraph` visitor. */
  const describeEmbed = (node: ImageNode, ctx: VisitorContext): DescribedEmbed | undefined => {
    const wiki = isWikiSyntax(node, ctx)
    const target = node.url
    const remote = !wiki && REMOTE.test(target)
    // A site-absolute `/x.png`, a `data:` URI, a bare `#fragment`: an address
    // the author wrote in full, pointing at something the vault does not hold.
    if (!wiki && !remote && EXTERNAL.test(target)) return undefined

    // Only a wikilink embed carries Obsidian's pipe rule; a markdown image's
    // `alt` is just alt text.
    const pipe = wiki ? wikiPipe(node, ctx) : undefined
    const { width, height, caption } = parseEmbedPipe(pipe)

    const assetPath = remote ? undefined : resolveAsset(target, fromPath, vault)
    const alt = caption ?? (wiki ? displayFor(target) : (node.alt ?? ''))
    /**
     * A local target with an extension jotter does not recognise is still an
     * image, which is what `![](notes/scan.tiff)` has always rendered as, and
     * the file is in the vault either way. A *remote* one is not: nothing says
     * `https://twitter.com/user/status/123` is a picture, and an `<img>` of it
     * is a broken-image icon on every reader's screen.
     */
    const kind = mediaKind(target) ?? (remote ? undefined : 'image')
    return { wiki, remote, target, kind, assetPath, width, height, caption, alt }
  }

  /**
   * What a file embed is labelled: the author's caption, then the alt text they
   * wrote, then the file's own name. For a remote target with none of those it
   * is the URL itself, because there is nothing else honest to call it.
   */
  const embedLabel = (embed: DescribedEmbed): string =>
    embed.caption ||
    (embed.wiki ? '' : embed.alt) ||
    (embed.remote ? embed.target : fileName(embed.assetPath ?? embed.target))

  /** The extension a file card wears as its own label; `link` for a bare URL. */
  const fileKind = (name: string): string => name.split('.').slice(1).pop()?.toLowerCase() ?? 'link'

  /**
   * The card: a named row that says what the file is before a reader opens it.
   * `data-file` carries the extension and the stylesheet draws it, so nothing
   * here needs an icon font to say "PDF".
   */
  const fileCard = (href: string, name: string, label: string, remote = false) => ({
    type: 'fileEmbed',
    data: {
      hName: 'a',
      hProperties: {
        className: ['file-embed'],
        href,
        'data-file': fileKind(name),
        // A remote embed is a link off the site, and gets what every other
        // link off the site gets.
        ...(remote ? { rel: 'noopener' } : {}),
      },
    },
    children: [{ type: 'text', value: label }],
  })

  /**
   * The element an embed becomes, for every kind except a picture: an `image`
   * node is left alone so Astro's pipeline still sees one.
   *
   * **A document is embedded, and carries a link.** Obsidian already encodes
   * which one the author wanted, in the bang: `![[Doc.pdf]]` is an inline
   * viewer and `[[Doc.pdf]]` is a link. Both are honoured rather than
   * flattened into the link. Three things make an embedded PDF expensive; the
   * markup answers two of them, and the first is an open cost, stated here so
   * that nobody has to rediscover it:
   *
   *   - it downloads the whole file on page load, and **`loading="lazy"` does
   *     not stop it**. Measured, not assumed: Chrome 152, a frame 15,000px
   *     below the fold, a logging server counting what it actually wrote. All
   *     519,123 bytes of the PDF went over the wire before the reader had
   *     scrolled once. `<img loading="lazy">` on the same page deferred
   *     correctly, so the attribute works and frames are the exception; a
   *     closed `<details>` and `display: none` defer nothing either. Only
   *     withholding `src` does, and that is JavaScript, which the README
   *     promises a feature-off build does not ship. The attribute stays
   *     because it is the correct declaration and costs nothing, but nothing
   *     here should be read as a claim that the bytes are deferred today: the
   *     page that reported this carries 456 KB of PDF against a 32 KB
   *     per-page JavaScript cap whose heaviest real page spends 28 KB.
   *   - mobile browsers render it as a blank box. `<iframe>` has no fallback
   *     content in static markup, so the link beside it is *always* visible
   *     rather than fallback: a phone that refuses the document would otherwise
   *     leave a reader with a blank box and no way forward.
   *   - the browser's own full-window viewer beats a pane in the page, for
   *     anybody who actually wants to read the thing. That is what the link
   *     opens.
   *
   * `#page=3` and `#height=400` are Obsidian's documented options for exactly
   * this embed. The height sizes the frame; the rest rides through to the URL
   * fragment, which the browser's viewer reads by itself.
   *
   * A *remote* document stays a card. An `<iframe>` of somebody else's origin
   * is a third party in the reader's page, which is the same reason a remote
   * embed naming no image is a link and not a frame.
   *
   * Video and audio keep their players, because those elements exist, cost no
   * JavaScript and stream rather than download. `preload="metadata"` is what
   * keeps the promise the byte budget makes: a header, not the file.
   */
  const embedNode = (embed: DescribedEmbed) => {
    const src = embed.remote
      ? embed.target
      : embedSrc(embed.assetPath as string, fromPath, config.images)
    const size = embedSize(embed, vault)

    if (embed.kind === 'video' || embed.kind === 'audio') {
      return {
        type: 'mediaEmbed',
        data: {
          hName: embed.kind,
          hProperties: {
            src,
            controls: true,
            preload: 'metadata',
            ...(embed.kind === 'video' ? size : {}),
          },
        },
        children: [],
      }
    }

    if (embed.kind === 'image') return undefined

    if (embed.kind === 'document' && !embed.remote) {
      const { height, fragment } = parseEmbedFragment(embed.target)
      const name = fileName(embed.assetPath ?? embed.target)
      return {
        type: 'documentEmbed',
        // A `<span>`, not a `<div>`: an embed that is not alone in its
        // paragraph stays inside the `<p>`, and a `<div>` there is invalid
        // nesting that Astro 7's compiler no longer quietly repairs. Both
        // children are phrasing content, so the wrapper is the only thing that
        // had to give, and it gives it in `display` rather than in markup.
        data: { hName: 'span', hProperties: { className: ['doc-embed'] } },
        children: [
          {
            type: 'documentFrame',
            data: {
              hName: 'iframe',
              hProperties: {
                className: ['doc-frame'],
                src: fragment ? `${src}${fragment}` : src,
                // An `<iframe>` with no accessible name is announced as
                // "frame", which is the one thing a reader already knows.
                title: name,
                loading: 'lazy',
                ...(height ? { height } : {}),
              },
            },
            children: [],
          },
          fileCard(src, name, name),
        ],
      }
    }

    return fileCard(src, fileName(embed.target), embedLabel(embed), embed.remote)
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

      /**
       * A link may point at an attachment rather than a note. `[[Doc.pdf]]` is
       * how Obsidian spells *link to this, do not embed it*, so it has to land
       * somewhere better than the dead-link span an unresolved note gets, and a
       * relative `[the paper](attachments/Doc.pdf)` says the same thing.
       *
       * `#page=3` survives into the href, where the browser's own PDF viewer
       * reads it. `#height=` does not: it sizes a frame, and there is no frame.
       */
      const asset = resolveAsset(node.url, fromPath, vault)
      if (asset) {
        const { fragment } = parseEmbedFragment(node.url)
        const href = assetHref(asset)
        ctx.setProperty(node, 'url', fragment ? `${href}${fragment}` : href)
        // A markdown link came with the words the author chose and keeps them.
        // A wikilink has none of its own: Satteri labelled it with the raw
        // target, so it gets the same card an unbanged embed would have got,
        // naming the file and its kind.
        if (wiki) {
          ctx.setProperty(node, 'data', {
            ...node.data,
            hProperties: {
              ...node.data?.hProperties,
              className: ['file-embed'],
              'data-file': fileKind(fileName(asset)),
            },
          })
          if (alias === undefined) {
            ctx.setProperty(node, 'children', [{ type: 'text', value: fileName(asset) }])
          }
        }
        return
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

      if (!embed.remote && !embed.assetPath) {
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

      // A player or a file card replaces the node outright; a picture stays an
      // `image`, because Astro's pipeline only processes the node type it knows.
      const replacement = embedNode(embed)
      if (replacement) {
        ctx.replaceNode(node, replacement)
        return
      }

      ctx.setProperty(node, 'url', embed.remote ? embed.target : embedSrc(embed.assetPath as string, fromPath, config.images))
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
      if (!embed || (!embed.remote && !embed.assetPath) || !embed.caption) return
      if (embed.wiki && !isMediaTarget(embed.target)) return

      /**
       * The caption is dropped from the embed itself before it is built: it is
       * about to be the `<figcaption>`, and a file card labelled with the same
       * words directly above it reads as a stutter. Its own name is what the
       * card should say.
       */
      const inner = embedNode({ ...embed, caption: undefined }) ?? {
        type: 'image',
        url: embed.remote ? embed.target : embedSrc(embed.assetPath as string, fromPath, config.images),
        alt: embed.alt,
        ...((size) => (size ? { data: { hProperties: size } } : {}))(embedSize(embed, vault)),
      }

      ctx.replaceNode(node, {
        type: 'figure',
        data: { hName: 'figure', hProperties: { className: ['embed-figure'] } },
        children: [
          inner,
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
