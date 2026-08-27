/**
 * Obsidian callout syntax: `> [!type] Optional title`, with `-` / `+` suffixes
 * for collapsed / expanded variants.
 *
 * `rehype-callouts` cannot run under Satteri, so this is ours. Pure string ->
 * struct; the Satteri adapter in src/markdown does the tree surgery.
 */

/**
 * Obsidian's callout types, mapped to the title jotter gives an untitled one.
 *
 * A label and nothing else. Each entry used to carry an `icon` name too —
 * `pencil`, `flame`, `check-circle` and ten others — feeding a `calloutIcon()`
 * that no component ever called, naming SVGs that were never in the repository.
 * `prose.css` states the design those leftovers predate: *"One rule set, one
 * hue variable. A callout type is a hue and nothing else."*
 */
export const CALLOUT_TYPES = {
  note: 'Note',
  abstract: 'Abstract',
  summary: 'Summary',
  tldr: 'TL;DR',
  info: 'Info',
  todo: 'Todo',
  tip: 'Tip',
  hint: 'Hint',
  important: 'Important',
  success: 'Success',
  check: 'Check',
  done: 'Done',
  question: 'Question',
  help: 'Help',
  faq: 'FAQ',
  warning: 'Warning',
  caution: 'Caution',
  attention: 'Attention',
  failure: 'Failure',
  fail: 'Fail',
  missing: 'Missing',
  danger: 'Danger',
  error: 'Error',
  bug: 'Bug',
  example: 'Example',
  quote: 'Quote',
  cite: 'Cite',
} as const

export type CalloutType = keyof typeof CALLOUT_TYPES

export interface Callout {
  /** Normalized, lowercase. Unknown types are kept verbatim, not discarded. */
  type: string
  /** Whether the type is one jotter styles; unknown types fall back to `note`. */
  known: boolean
  title: string
  /** `undefined` when not collapsible at all. */
  collapsible: boolean
  /** Only meaningful when `collapsible`. */
  defaultOpen: boolean
  /** Length of the matched marker, so the caller can slice the body after it. */
  markerLength: number
}

const CALLOUT = /^\[!([^\]\s]+)\]([-+])?[ \t]*(.*)$/

/**
 * Parse the opening line of a blockquote. Returns `undefined` when it is an
 * ordinary quote, which must keep rendering as a `<blockquote>`.
 *
 * Takes the whole first text value, not a pre-split line: Satteri hands a
 * blockquote's opening paragraph over as one `text` node whose value still
 * contains the newlines, so the marker line has to be separated here.
 */
export function parseCallout(text: string): Callout | undefined {
  const firstLine = text.split('\n', 1)[0]
  const match = CALLOUT.exec(firstLine.trimStart())
  if (!match) return undefined

  const [full, rawType, fold, rawTitle] = match
  const type = rawType.toLowerCase()
  const known = Object.hasOwn(CALLOUT_TYPES, type)
  const leading = firstLine.length - firstLine.trimStart().length

  return {
    type,
    known,
    // Obsidian titles an untitled callout with its type, capitalized.
    title: rawTitle.trim() || (known ? CALLOUT_TYPES[type as CalloutType] : capitalize(type)),
    collapsible: fold !== undefined,
    defaultOpen: fold === '+',
    markerLength: leading + full.length,
  }
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
