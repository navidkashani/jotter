/**
 * The hast half of per-block text direction: read each block, and mark the ones
 * whose direction differs from the page's.
 *
 * The rule itself is `src/lib/bidi.ts`; this decides *which* nodes get asked
 * and what each one inherits.
 *
 * ## Why hast, and not mdast like every other jotter plugin
 *
 * A transcluded paragraph. `src/markdown/transclude.ts` replaces the embed with
 * a raw markdown string and `src/lib/transclude.ts` wraps it in a literal
 * `<aside class="transclusion">`; by the time that is parsed, the `<aside>` is
 * a `raw` node and the body between the blank lines is a real `<p>`. An mdast
 * plugin structurally cannot reach that paragraph: it does not exist yet when
 * mdast runs. On the hast side it is an ordinary element, and the walk below
 * finds it without knowing transclusion exists.
 *
 * Two things fall out for free. Nothing inside `<pre><code>` is ever visited,
 * because the walk is tag-based and stops at `pre`. And Astro composes
 * `[highlighter] -> [hastPlugins] -> [image marker] -> [heading ids]`, so the
 * `<pre>` Shiki built is already there to be marked.
 *
 * ## Why one recursive walk rather than filtered `element` visitors
 *
 * Inheritance. A block only emits a `dir` when it *differs* from what it
 * inherits, so every node needs its parent's resolved direction, and the
 * filtered visitor API makes no parent-before-child ordering guarantee. The
 * walk carries `inherited` down, which is the only way to get "no redundant
 * `dir` on a child of a marked block" right.
 */
import type { HastVisitorContext } from 'satteri'
import type { Element, Root } from 'hast'

import { normalizeDirection, textDir, type Direction } from '../lib/bidi.js'
import type { DocumentContext } from './context.js'

/**
 * The blocks that get asked.
 *
 * Obsidian Publish marks `h1..h6, blockquote, .callout-title` unconditionally
 * and `li, p` when their parent carries no `dir` of its own; this is the same
 * set widened by the block containers Publish happens not to reach: table
 * cells, definition lists, figure captions and `aside`.
 *
 * `li` and never `ul`, deliberately: the marker box belongs to the item, so a
 * per-item `dir` puts each bullet on the correct side of its own line. A `dir`
 * on the list would put every bullet on the side the *first* item chose.
 */
const BLOCKS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'td',
  'th',
  'dt',
  'dd',
  'figcaption',
  'summary',
  'aside',
])

/**
 * A non-collapsible callout's title. `src/markdown/callouts.ts` gives it
 * `hName: 'div'` (the collapsible form is a `summary`, which `BLOCKS` already
 * covers), and it is the same element Obsidian Publish targets by this class.
 */
const isCalloutTitle = (node: Element): boolean =>
  node.tagName === 'div' && classNames(node).includes('callout-title')

function classNames(node: Element): string[] {
  const value: unknown = node.properties?.className
  if (Array.isArray(value)) return value.map(String)
  return typeof value === 'string' ? value.split(/\s+/) : []
}

export function direction(doc: DocumentContext) {
  const { vault, config, fromPath } = doc

  /**
   * What the whole document inherits: the site's direction, unless the note
   * overrides it. A note that is entirely Persian on an English site can set
   * `direction: rtl` to flip its own baseline, and then only its *English*
   * blocks are marked: the same rendering, fewer attributes.
   *
   * `auto` and an unreadable value both fall through to `config.dir`, which is
   * what `auto` asks for anyway. The scan warns about the unreadable one.
   *
   * One baseline for the whole document, transcluded content included: an
   * embedded note is being read *here*, on this page, so it takes this page's
   * direction. Its own `direction:` steers the page it is the subject of.
   */
  const declared = normalizeDirection(vault.byPath.get(fromPath.toLowerCase())?.frontmatter.direction)
  const base: Direction = declared === 'ltr' || declared === 'rtl' ? declared : config.dir

  return {
    name: 'jotter:direction',

    after(root: Readonly<Root>, ctx: HastVisitorContext) {
      const walk = (node: Readonly<Root | Element>, inherited: Direction): void => {
        for (const child of node.children ?? []) {
          if (child.type !== 'element') continue
          const element = child as Element

          /**
           * Code is left-to-right prose about a left-to-right language, and it
           * is a `<pre>` whose content must not be re-ordered. But it is
           * emitted under the same rule as everything else rather than forced:
           * an unconditional `dir="ltr"` here is a redundant attribute on every
           * code block of every LTR site, which is the zero-cost claim broken.
           * Never descended into: the `<code>` and Shiki's spans below it
           * inherit correctly and have nothing of their own to say.
           */
          if (element.tagName === 'pre') {
            if (inherited !== 'ltr') ctx.setProperty(element, 'dir', 'ltr')
            continue
          }

          let own = inherited
          if (BLOCKS.has(element.tagName) || isCalloutTitle(element)) {
            const dir = textDir(ctx.textContent(element), inherited)
            if (dir) {
              ctx.setProperty(element, 'dir', dir)
              own = dir
            }
          }

          walk(element, own)
        }
      }

      walk(root, base)
    },
  }
}
