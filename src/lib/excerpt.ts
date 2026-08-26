/**
 * First paragraph, with markdown stripped: used for note cards, hover previews
 * and meta descriptions.
 *
 * Deliberately a string transform rather than a render pass. It runs for every
 * note in a listing, and rendering 1,000 notes to HTML to take their first
 * sentence is how a build gets slow.
 */

const STRIP: readonly [RegExp, string][] = [
  [/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''], // frontmatter
  [/```[\s\S]*?```/g, ''], // fenced code
  [/%%[\s\S]*?%%/g, ''], // Obsidian comments
  [/!\[\[[^\]]*\]\]/g, ''], // embeds
  [/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2'], // aliased wikilink -> alias
  [/\[\[([^\]]*)\]\]/g, '$1'], // wikilink -> target
  [/!\[[^\]]*\]\([^)]*\)/g, ''], // images
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'], // links -> text
  [/^\s{0,3}>\s?/gm, ''], // blockquote markers
  [/^\s{0,3}#{1,6}[ \t]+.*$/gm, ''], // heading lines, dropped whole: the title already shows them
  [/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, ''], // list markers
  [/(\*\*|__|==|~~)(.*?)\1/g, '$2'], // strong / highlight / strike
  [/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2'], // emphasis
  [/`([^`]*)`/g, '$1'], // inline code
  [/<[^>]+>/g, ''], // stray html
]

export function excerpt(markdown: string, maxLength = 200): string {
  let text = markdown
  for (const [pattern, replacement] of STRIP) text = text.replace(pattern, replacement)

  const paragraph = text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .find((p) => p.length > 0)

  if (!paragraph) return ''
  if (paragraph.length <= maxLength) return paragraph

  // Cut on a word boundary so the ellipsis never lands mid-word.
  const cut = paragraph.slice(0, maxLength)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}
