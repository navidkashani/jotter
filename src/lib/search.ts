/**
 * Every decision the search modal makes that has a right answer, kept where
 * vitest can reach it.
 *
 * `src/scripts/search.ts` has no test harness and cannot get one cheaply, so
 * the split is deliberate rather than tidy: that file wires up elements and
 * awaits things, and everything here is a pure function over plain values.
 *
 * This file is the one exception to the boundary `local-graph.ts` and
 * `hover-preview.ts` both declare — that nothing in `src/scripts/` may import
 * from `src/lib/`. The reason for that rule is that `src/lib/` is build-time
 * code and reaches for `node:fs`; this module imports nothing at all, from
 * anywhere, and nothing in it touches a global. So it bundles into the
 * browser cleanly *and* it is testable without a DOM, which is the whole
 * argument `src/lib/preview.ts` made for the build-time half of hover previews.
 *
 * Keep it that way. The moment this file imports something node-shaped, the
 * search script stops building.
 */

/**
 * Pagefind emits `/foo/` for `dist/foo/index.html`. jotter is
 * `trailingSlash: 'never'` and every other href on the site is `/foo`, so
 * without this every result would disagree with the page's own canonical URL
 * and with every link pointing at it.
 *
 * The homepage is the case that makes this more than a `replace`: `/` is
 * already spelled the way jotter spells it, and trimming it would produce an
 * empty href.
 *
 * `#anchor` survives, because sub-results are the reason heading jumps work.
 */
export function normalizeResultUrl(url: string): string {
  const hash = url.indexOf('#')
  const path = hash === -1 ? url : url.slice(0, hash)
  const anchor = hash === -1 ? '' : url.slice(hash)
  const trimmed = path.replace(/\/+$/, '')
  return `${trimmed || '/'}${anchor}`
}

/**
 * The heading jumps worth showing under a result.
 *
 * Pagefind's `sub_results` carry the matching section's `#anchor`, and those
 * resolve against Astro's own heading ids — which `anchorFor()` already mirrors
 * — so nothing needs mapping. Two things have to be dropped, though.
 *
 * The **first sub-result is always the page itself**, anchorless, which the
 * result's own link already is. Comparing normalised hrefs drops it without
 * depending on Pagefind's ordering staying what it is today.
 *
 * And two sections can normalise to the same href — an empty heading, or a
 * duplicate one — which would render the same jump twice. `seen` is primed
 * with the page so one pass does both jobs.
 *
 * Generic so the caller keeps its excerpt fields: this decides *which*
 * sub-results survive and what each one links to, and nothing about rendering.
 */
export function headingJumps<T extends { url: string }>(
  subResults: readonly T[] | undefined,
  pageHref: string,
  limit: number,
): (T & { href: string })[] {
  const seen = new Set<string>([pageHref])
  const jumps: (T & { href: string })[] = []

  for (const sub of subResults ?? []) {
    if (jumps.length >= limit) break
    const href = normalizeResultUrl(sub.url)
    if (seen.has(href)) continue
    seen.add(href)
    jumps.push({ ...sub, href })
  }
  return jumps
}

/**
 * Where the arrow keys move next, as an index into the focus stops.
 *
 * The stops are the field followed by every result link, and focus really
 * moves between them rather than a highlight moving under
 * `aria-activedescendant`: each result is an `<a href>`, so a screen reader
 * announces it as a link when focus lands, Enter activates it with no handler
 * of jotter's own, and modifier-clicks keep working.
 *
 * Deliberately does **not** wrap. A list that jumps from the last result back
 * to the field on one more press is disorienting when you are scanning, and
 * both ends are one keystroke from somewhere useful anyway.
 *
 * `current` is `-1` when focus is somewhere else in the dialog — the close
 * button, or the dialog itself. The clamp already sends both directions home
 * to the field from there, which is the right answer and worth noticing rather
 * than rediscovering: `-1 + 1` and `-1 - 1` both clamp to `0`.
 */
export function nextStop(current: number, count: number, delta: number): number {
  if (count <= 0) return -1
  return Math.min(Math.max(current + delta, 0), count - 1)
}

/** As much of the focused element as the shortcut guard reads. */
export interface FocusTarget {
  tagName: string
  isContentEditable: boolean
}

/**
 * Is the reader typing into something?
 *
 * Cmd/Ctrl+K is ignored when they are, and the case that matters most is the
 * search field itself: without this, pressing it again while typing would
 * re-open the dialog and wipe the query.
 */
export function isTypingTarget(element: FocusTarget | null | undefined): boolean {
  if (!element) return false
  return element.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(element.tagName)
}

/** A run of excerpt text, and whether Pagefind marked it as a hit. */
export interface ExcerptPart {
  text: string
  mark: boolean
}

/**
 * As much of a DOM node as the sanitiser reads. Narrow on purpose: it makes
 * the function testable from `environment: 'node'`, where there is no DOM at
 * all, without pulling in jsdom for two assertions.
 */
export interface ExcerptNode {
  nodeType: number
  nodeName: string
  textContent: string | null
}

const TEXT_NODE = 3
const ELEMENT_NODE = 1

/**
 * Pagefind's `excerpt` is *escaped* HTML containing `<mark>` — `&amp;` for an
 * ampersand, `&#x27;` for an apostrophe. Splitting the string on the tags and
 * setting the pieces as text would therefore render those entities literally,
 * and using `innerHTML` to decode them would break the invariant that nothing
 * in `src/` ever does.
 *
 * So the caller parses it with `DOMParser` — which neither executes scripts nor
 * loads resources — and this reduces the result to text runs. Entities decode
 * correctly because the parser decoded them, the rebuilt DOM is `textContent`
 * only, and anything unexpected in the excerpt is *dropped* rather than
 * rendered: only text nodes and `<mark>` elements survive.
 *
 * Adjacent runs of the same kind are merged, so a `<mark>` split across two
 * text nodes becomes one element rather than two.
 */
export function excerptParts(nodes: Iterable<ExcerptNode>): ExcerptPart[] {
  const parts: ExcerptPart[] = []
  for (const node of nodes) {
    const mark = node.nodeType === ELEMENT_NODE && node.nodeName.toUpperCase() === 'MARK'
    if (!mark && node.nodeType !== TEXT_NODE) continue

    const text = node.textContent ?? ''
    if (!text) continue

    const last = parts[parts.length - 1]
    if (last && last.mark === mark) last.text += text
    else parts.push({ text, mark })
  }
  return parts
}
