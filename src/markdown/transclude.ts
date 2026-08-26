/**
 * The mdast half of transclusion. All of the work is in `src/lib/transclude.ts`;
 * this decides *where* an expansion is allowed to land.
 *
 * Like figures, a transclusion is handled at the `paragraph`, not the `image`:
 * it produces block content, and block content inside a `<p>` is invalid
 * nesting that Astro 7's compiler no longer silently repairs. A note embed that
 * is not alone in its paragraph becomes a plain link to the target instead,
 * which is the honest fallback.
 */
import { expandTransclusions } from '../lib/transclude.js'
import { resolveLink, displayFor, splitTarget } from '../lib/resolve.js'
import { isMediaTarget } from '../lib/embed.js'
import { noteHref } from '../lib/href.js'
import { isWikiSyntax, type DocumentContext, type VisitorContext, type Positioned } from './context.js'

interface ImageNode extends Positioned {
  type: 'image'
  url: string
  alt?: string | null
}

export function transclude(doc: DocumentContext) {
  const { vault, config, fromPath } = doc
  const options = { maxDepth: config.transcludeDepth, linkResolution: config.linkResolution }

  const isNoteEmbed = (node: ImageNode, ctx: VisitorContext) =>
    node?.type === 'image' && isWikiSyntax(node, ctx) && !isMediaTarget(node.url)

  return {
    name: 'jotter:transclude',
    options: { position: true },

    paragraph(node: { children?: unknown[] }, ctx: VisitorContext) {
      const children = node.children ?? []
      if (children.length !== 1) return

      const only = children[0] as ImageNode
      if (!isNoteEmbed(only, ctx)) return

      const resolution = resolveLink(only.url, fromPath, vault, config.linkResolution)
      if (resolution.status !== 'published') {
        ctx.replaceNode(node, {
          type: 'paragraph',
          children: [
            {
              type: 'missingTransclusion',
              data: { hName: 'span', hProperties: { className: ['dead-link'] } },
              children: [{ type: 'text', value: displayFor(only.url) }],
            },
          ],
        })
        return
      }

      const { subpath } = splitTarget(only.url)
      // The host note starts the stack, so a note embedding itself is a cycle.
      const markdown = expandTransclusions(
        `![[${only.url}]]`,
        fromPath,
        vault,
        options,
        [vault.byPath.get(fromPath.toLowerCase())?.slug ?? fromPath],
      )

      ctx.replaceNode(node, { raw: markdown, mdxExpressions: false })
      void subpath
    },

    /**
     * An embed sharing a paragraph with other content cannot become a block, so
     * it degrades to a link rather than producing invalid markup.
     *
     * A *lone* embed belongs to the paragraph visitor above. Both firing would
     * queue two transforms on the same subtree, and Satteri drops the loser
     * with a warning.
     */
    image(node: ImageNode, ctx: VisitorContext) {
      if (!isNoteEmbed(node, ctx)) return

      const parent = ctx.parent(node)
      if (parent?.type === 'paragraph' && parent.children?.length === 1) return

      const resolution = resolveLink(node.url, fromPath, vault, config.linkResolution)
      const { subpath } = splitTarget(node.url)
      const label = displayFor(node.url)

      if (resolution.status !== 'published') {
        ctx.replaceNode(node, {
          type: 'missingTransclusion',
          data: { hName: 'span', hProperties: { className: ['dead-link'] } },
          children: [{ type: 'text', value: label }],
        })
        return
      }

      ctx.replaceNode(node, {
        type: 'link',
        url: noteHref(resolution.note.slug, subpath),
        data: { hProperties: { className: ['inline-transclusion'] } },
        children: [{ type: 'text', value: label }],
      })
    },
  }
}
