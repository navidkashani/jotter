/**
 * The four text-level Obsidian syntaxes, tokenized in one pass:
 * `%%comments%%`, `==highlights==`, `#tags`, and soft line breaks.
 *
 * The plan called for four separate Satteri plugins. They are one pure
 * tokenizer and one adapter instead, for two reasons: four plugins means four
 * traversals and four NAPI crossings per document, which is real cost on a
 * 1,000-note vault; and each pass would re-scan text the previous pass had just
 * created, making their relative order load-bearing in a way nothing documents.
 * One ordered scan has neither problem, and the rules stay pure and testable
 * here, which is what the processor-agnostic core was actually for.
 *
 * Nothing here needs to guard against code: a Satteri `text` visitor never sees
 * inside a `code` or `inlineCode` node, so a `#tag` or `==x==` in a fence is
 * untouched with no special handling.
 */

export type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'mark'; value: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'break' }

export interface InlineOptions {
  /** Obsidian's own default is `false`: a single newline becomes a `<br>`. */
  strictLineBreaks?: boolean
  tags?: boolean
  highlight?: boolean
  comments?: boolean
}

/**
 * `%%...%%` spanning a whole block, and `%%...%%` inline. Obsidian allows a
 * comment to span paragraphs; that form arrives as separate text nodes and is
 * out of scope for v1, which is documented rather than silently half-working.
 */
const COMMENT = /%%[\s\S]*?%%/g

/** `==text==`, non-greedy, not spanning a blank line, no empty highlight. */
const HIGHLIGHT = /==(?!\s)([^\n]*?[^\s=])==/

/**
 * Obsidian tags: letters, numbers, `_`, `-`, `/`; never all digits, so `#123`
 * stays an issue reference. Must start at a boundary so `a#b` is not a tag.
 */
const TAG = /(^|[\s(\[{'"])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/u

export function tokenizeInline(input: string, options: InlineOptions = {}): InlineToken[] {
  const {
    strictLineBreaks = false,
    tags = true,
    highlight = true,
    comments = true,
  } = options

  // Comments come off first: they can hide any of the other syntaxes, and a
  // reader who commented something out meant all of it.
  const source = comments ? input.replace(COMMENT, '') : input

  const tokens: InlineToken[] = []
  let rest = source

  const pushText = (value: string) => {
    if (!value) return
    const last = tokens[tokens.length - 1]
    if (last?.kind === 'text') last.value += value
    else tokens.push({ kind: 'text', value })
  }

  while (rest) {
    // Find whichever of the three comes first.
    const candidates: { at: number; length: number; token: InlineToken; skip: number }[] = []

    if (highlight) {
      const m = HIGHLIGHT.exec(rest)
      if (m) candidates.push({ at: m.index, length: m[0].length, token: { kind: 'mark', value: m[1] }, skip: 0 })
    }
    if (tags) {
      const m = TAG.exec(rest)
      if (m) {
        candidates.push({
          at: m.index,
          length: m[0].length,
          token: { kind: 'tag', tag: m[2] },
          // The boundary character is part of the match but belongs to the text.
          skip: m[1].length,
        })
      }
    }
    if (!strictLineBreaks) {
      const at = rest.indexOf('\n')
      if (at !== -1) candidates.push({ at, length: 1, token: { kind: 'break' }, skip: 0 })
    }

    if (candidates.length === 0) {
      pushText(rest)
      break
    }

    // Earliest wins; on a tie the longer match wins, so `==#tag==` highlights.
    candidates.sort((a, b) => a.at - b.at || b.length - a.length)
    const { at, length, token, skip } = candidates[0]

    pushText(rest.slice(0, at + skip))
    tokens.push(token)
    rest = rest.slice(at + length)
  }

  return tokens
}

/** True when tokenizing would change nothing, so the caller can skip the node. */
export function isInlinePlain(value: string, options: InlineOptions = {}): boolean {
  const { strictLineBreaks = false, tags = true, highlight = true, comments = true } = options
  if (comments && value.includes('%%')) return false
  if (highlight && value.includes('==')) return false
  if (tags && value.includes('#')) return false
  if (!strictLineBreaks && value.includes('\n')) return false
  return true
}
