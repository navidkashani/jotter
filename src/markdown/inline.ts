/**
 * The text-level syntaxes: `%%comments%%`, `==highlights==`, `#tags` and soft
 * line breaks, applied in one traversal.
 *
 * The rules live in `src/lib/inline.ts` as a pure tokenizer. This is only the
 * mdast half: tokens in, nodes out.
 *
 * A soft break is *not* a `break` node in Satteri: it is a `\n` inside a text
 * value, which is why `strictLineBreaks` is handled here and not by a `break`
 * visitor. Obsidian's own default is `strictLineBreaks: false`, so a single
 * newline becomes a `<br>`.
 */
import { tokenizeInline, isInlinePlain, type InlineToken } from '../lib/inline.js'
import { tagHref } from '../lib/href.js'
import type { DocumentContext, VisitorContext } from './context.js'

interface TextNode {
  type: 'text'
  value: string
}

const nodeFor = (token: InlineToken): unknown => {
  switch (token.kind) {
    case 'text':
      return { type: 'text', value: token.value }
    case 'break':
      return { type: 'break' }
    case 'mark':
      return {
        type: 'highlight',
        data: { hName: 'mark' },
        children: [{ type: 'text', value: token.value }],
      }
    case 'tag':
      return {
        type: 'tagChip',
        data: {
          hName: 'a',
          hProperties: { className: ['tag-chip'], href: tagHref(token.tag), 'data-tag': token.tag },
        },
        children: [{ type: 'text', value: `#${token.tag}` }],
      }
  }
}

export function inlineSyntax(doc: DocumentContext) {
  const options = {
    strictLineBreaks: doc.config.strictLineBreaks,
    tags: doc.config.features.tags,
    highlight: true,
    comments: true,
  }

  return {
    name: 'jotter:inline',

    text(node: TextNode, ctx: VisitorContext) {
      // The overwhelmingly common case is prose with none of these in it.
      if (isInlinePlain(node.value, options)) return

      const tokens = tokenizeInline(node.value, options)
      if (tokens.length === 0) {
        ctx.removeNode(node)
        return
      }
      if (tokens.length === 1 && tokens[0].kind === 'text') {
        if (tokens[0].value !== node.value) ctx.setProperty(node, 'value', tokens[0].value)
        return
      }

      ctx.replaceNode(node, tokens.map(nodeFor))
    },
  }
}
