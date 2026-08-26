/**
 * Byte ranges a raw-text pass must not touch: frontmatter, fenced code blocks
 * and inline code spans.
 *
 * A `[[link]]` inside a code fence is documentation *about* links and must
 * survive verbatim. Ported from open-publish's `scripts/lib/rewrite.mjs` so the
 * two projects agree byte-for-byte on what "protected" means.
 *
 * Note this exists for exactly one caller: `vault.ts`, which extracts link
 * edges from raw markdown *before* a markdown processor exists. Everywhere
 * else, Sätteri does the parsing and a `text` visitor never sees inside a
 * `code` or `inlineCode` node, so protection is free.
 */

export type Range = readonly [start: number, end: number]

export function protectedRanges(text: string): Range[] {
  const ranges: Range[] = []
  const lines = text.split('\n')
  let offset = 0
  let fence: string | null = null

  // YAML frontmatter, when the file opens with it.
  if (lines[0]?.trim() === '---') {
    let cursor = lines[0].length + 1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        ranges.push([0, cursor + lines[i].length])
        break
      }
      cursor += lines[i].length + 1
    }
  }

  for (const line of lines) {
    const trimmed = line.trimStart()
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed)

    if (fence) {
      ranges.push([offset, offset + line.length])
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null
    } else if (fenceMatch) {
      fence = fenceMatch[1]
      ranges.push([offset, offset + line.length])
    } else {
      // Inline code spans, matching the longest run of backticks first.
      const spans = /(`+)(?:(?!\1)[\s\S])*\1/g
      let match: RegExpExecArray | null
      while ((match = spans.exec(line)) !== null) {
        ranges.push([offset + match.index, offset + match.index + match[0].length])
      }
    }
    offset += line.length + 1
  }

  return ranges
}

export const isProtected = (ranges: readonly Range[], index: number): boolean =>
  ranges.some(([start, end]) => index >= start && index < end)

/**
 * Heading anchors, matching how Astro (github-slugger) slugifies them, so a
 * `[[Note#Heading]]` lands on the id the renderer actually emitted.
 */
export function anchorFor(subpath: string | undefined): string {
  if (!subpath || subpath.startsWith('#^')) return '' // block refs have no stable URL anchor
  return (
    '#' +
    subpath
      .slice(1)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
  )
}
