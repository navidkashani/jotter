/**
 * Obsidian callout syntax: `> [!type] Optional title`, with `-` / `+` suffixes
 * for collapsed / expanded variants.
 *
 * `rehype-callouts` cannot run under Satteri, so this is ours. Pure string ->
 * struct; the Satteri adapter in src/markdown does the tree surgery.
 */

export const CALLOUT_TYPES = {
  note: { icon: 'pencil', label: 'Note' },
  abstract: { icon: 'clipboard', label: 'Abstract' },
  summary: { icon: 'clipboard', label: 'Summary' },
  tldr: { icon: 'clipboard', label: 'TL;DR' },
  info: { icon: 'info', label: 'Info' },
  todo: { icon: 'check-circle', label: 'Todo' },
  tip: { icon: 'flame', label: 'Tip' },
  hint: { icon: 'flame', label: 'Hint' },
  important: { icon: 'flame', label: 'Important' },
  success: { icon: 'check', label: 'Success' },
  check: { icon: 'check', label: 'Check' },
  done: { icon: 'check', label: 'Done' },
  question: { icon: 'help', label: 'Question' },
  help: { icon: 'help', label: 'Help' },
  faq: { icon: 'help', label: 'FAQ' },
  warning: { icon: 'alert', label: 'Warning' },
  caution: { icon: 'alert', label: 'Caution' },
  attention: { icon: 'alert', label: 'Attention' },
  failure: { icon: 'cross', label: 'Failure' },
  fail: { icon: 'cross', label: 'Fail' },
  missing: { icon: 'cross', label: 'Missing' },
  danger: { icon: 'zap', label: 'Danger' },
  error: { icon: 'zap', label: 'Error' },
  bug: { icon: 'bug', label: 'Bug' },
  example: { icon: 'list', label: 'Example' },
  quote: { icon: 'quote', label: 'Quote' },
  cite: { icon: 'quote', label: 'Cite' },
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
    title: rawTitle.trim() || (known ? CALLOUT_TYPES[type as CalloutType].label : capitalize(type)),
    collapsible: fold !== undefined,
    defaultOpen: fold === '+',
    markerLength: leading + full.length,
  }
}

export const calloutIcon = (type: string): string =>
  Object.hasOwn(CALLOUT_TYPES, type) ? CALLOUT_TYPES[type as CalloutType].icon : CALLOUT_TYPES.note.icon

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
