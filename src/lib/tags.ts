/**
 * Tags come from two places in Obsidian and must be merged: the `tags:`
 * frontmatter key and inline `#tags` in prose. Nested tags (`#method/zettelkasten`)
 * roll up, so a note tagged `method/zettelkasten` also appears under `method`.
 */
import { protectedRanges, isProtected } from './protected.js'

/** Obsidian allows letters, numbers, `_`, `-` and `/`; a tag may not be all digits. */
const INLINE_TAG = /(^|[\s(\[{'"])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu

export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#/, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
}

/** Extract inline `#tags` from prose, never from code or frontmatter. */
export function inlineTags(body: string): string[] {
  const ranges = protectedRanges(body)
  const found: string[] = []
  let match: RegExpExecArray | null
  INLINE_TAG.lastIndex = 0
  while ((match = INLINE_TAG.exec(body)) !== null) {
    const at = match.index + match[1].length
    if (isProtected(ranges, at)) continue
    const tag = normalizeTag(match[2])
    if (tag) found.push(tag)
  }
  return found
}

/** Frontmatter `tags:` accepts a list, a string, or a comma-separated string. */
export function frontmatterTags(value: unknown): string[] {
  if (value == null) return []
  const raw = Array.isArray(value) ? value : String(value).split(',')
  return raw.map((t) => normalizeTag(String(t))).filter(Boolean)
}

/** Merge both sources, de-duplicated, order-stable. */
export function mergeTags(frontmatter: unknown, body: string): string[] {
  return [...new Set([...frontmatterTags(frontmatter), ...inlineTags(body)])]
}

/**
 * `method/zettelkasten` implies `method`. Rolling up is what makes
 * `/tags/method` list everything beneath it rather than only exact matches.
 */
export function expandTag(tag: string): string[] {
  const parts = tag.split('/').filter(Boolean)
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

export interface TagNode {
  tag: string
  /** Last segment, for display: `zettelkasten` from `method/zettelkasten`. */
  label: string
  /** Notes carrying this exact tag or any tag beneath it. */
  count: number
  children: TagNode[]
}

/** Build the hierarchical tag tree, with parent counts including children. */
export function tagTree(taggedNotes: readonly { tags: readonly string[] }[]): TagNode[] {
  const counts = new Map<string, number>()
  for (const note of taggedNotes) {
    const expanded = new Set(note.tags.flatMap(expandTag))
    for (const tag of expanded) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }

  const byTag = new Map<string, TagNode>()
  for (const tag of [...counts.keys()].sort()) {
    byTag.set(tag, {
      tag,
      label: tag.split('/').pop() ?? tag,
      count: counts.get(tag) ?? 0,
      children: [],
    })
  }

  const roots: TagNode[] = []
  for (const node of byTag.values()) {
    const parentTag = node.tag.split('/').slice(0, -1).join('/')
    const parent = parentTag ? byTag.get(parentTag) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}
