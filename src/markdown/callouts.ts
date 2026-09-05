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

/** A text node, or any other inline node sitting beside one in a paragraph. */
type InlineNode = TextNode | { type: string }

const isText = (node: InlineNode): node is TextNode => node.type === 'text'

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

      /**
       * A title can continue past the text node `parseCallout` read.
       *
       * `> [!info] [a link](…)` arrives as two siblings — the text `[!info] `
       * and a `link` — because the parser lifts inline syntax out of the text
       * run. So the marker consumed the whole text node, `parseCallout` saw no
       * title, and the link was body as far as the code below was concerned:
       * it deleted the paragraph and the callout rendered as the bare word
       * `Info`, with the URL nowhere on the page. The same went for a title
       * written with `**bold**`, `code` or a `[[wikilink]]`.
       *
       * Those siblings are title, up to the first newline. Anything left in
       * `afterMarker` means the line ended inside the text node and the title
       * was plain, which is the ordinary case and unchanged.
       */
      const children = (firstChild.children ?? []) as InlineNode[]
      const afterMarker = firstText.value.slice(callout.markerLength)

      const titleNodes: unknown[] = []
      let body: unknown[] = []

      if (afterMarker === '') {
        let split = children.length
        for (let i = 1; i < children.length; i++) {
          const child = children[i]
          if (!isText(child) || !child.value.includes('\n')) {
            titleNodes.push(child)
            continue
          }
          const newline = child.value.indexOf('\n')
          const head = child.value.slice(0, newline)
          const tail = child.value.slice(newline + 1)
          if (head) titleNodes.push({ type: 'text', value: head })
          body = tail ? [{ type: 'text', value: tail }, ...children.slice(i + 1)] : children.slice(i + 1)
          split = -1
          break
        }
        if (split !== -1) body = []
      }

      ctx.setProperty(node, 'children', [
        {
          type: 'calloutTitle',
          data: {
            hName: callout.collapsible ? 'summary' : 'div',
            hProperties: { className: ['callout-title'] },
          },
          children: titleNodes.length
            ? [
                // `rawTitle`, not `title`: the fallback label would print
                // `Info` in front of the author's own link, and trimming would
                // close the gap before it.
                ...(callout.rawTitle ? [{ type: 'text', value: callout.rawTitle }] : []),
                ...titleNodes,
              ]
            : [{ type: 'text', value: callout.title }],
        },
        ...(node.children ?? []),
      ])

      if (titleNodes.length > 0) {
        if (body.length > 0) ctx.setProperty(firstChild, 'children', body)
        else ctx.removeNode(firstChild)
        return
      }

      // Whatever followed the marker on the same line is body, not title.
      const rest = afterMarker.replace(/^\r?\n/, '')
      if (rest.trim()) ctx.setProperty(firstText, 'value', rest)
      else ctx.removeNode(firstChild)
    },
  }
}
