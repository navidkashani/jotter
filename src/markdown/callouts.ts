/**
 * Obsidian callouts: `> [!type] Title`, with `-`/`+` for the collapsible forms.
 *
 * `rehype-callouts` cannot run under Satteri, so this is ours. It is small
 * because it does not rebuild the tree: it relabels the existing `blockquote`
 * and prepends a title. Moving a blockquote's children into a new wrapper would
 * mean handing parsed nodes back to the engine as fresh content, and relabelling
 * sidesteps that entirely.
 *
 * Satteri hands the whole first paragraph over as a single `text` value with
 * embedded newlines, so the marker line and the first line of body arrive
 * together and have to be split here rather than by walking siblings.
 */
import { parseCallout } from '../lib/callout.js'
import type { VisitorContext } from './context.js'

interface TextNode {
  type: 'text'
  value: string
}

interface ParentNode {
  type: string
  children?: unknown[]
}

export function callouts() {
  return {
    name: 'jotter:callouts',

    blockquote(node: ParentNode, ctx: VisitorContext) {
      const firstChild = node.children?.[0] as ParentNode | undefined
      if (firstChild?.type !== 'paragraph') return

      const firstText = firstChild.children?.[0] as TextNode | undefined
      if (firstText?.type !== 'text') return

      const callout = parseCallout(firstText.value)
      if (!callout) return

      ctx.setProperty(node, 'data', {
        hName: callout.collapsible ? 'details' : 'div',
        hProperties: {
          className: ['callout'],
          'data-callout': callout.type,
          ...(callout.collapsible ? { open: callout.defaultOpen || null } : {}),
        },
      })

      ctx.setProperty(node, 'children', [
        {
          type: 'calloutTitle',
          data: {
            hName: callout.collapsible ? 'summary' : 'div',
            hProperties: { className: ['callout-title'] },
          },
          children: [{ type: 'text', value: callout.title }],
        },
        ...(node.children ?? []),
      ])

      // Whatever followed the marker on the same line is body, not title.
      const rest = firstText.value.slice(callout.markerLength).replace(/^\r?\n/, '')
      if (rest.trim()) ctx.setProperty(firstText, 'value', rest)
      else ctx.removeNode(firstChild)
    },
  }
}
