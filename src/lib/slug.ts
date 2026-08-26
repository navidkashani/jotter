/**
 * Path → URL slug. Obsidian filenames are human text: spaces, emoji, Cyrillic,
 * ampersands. The slug must be a legal URL, stable across builds, and readable.
 *
 * Non-ASCII letters are *kept*, not transliterated away — a Cyrillic vault
 * should not slug every note to `note-1`, `note-2`. Browsers percent-encode
 * them on the wire and display them decoded.
 */

/** Slugify one path segment. */
export function slugifySegment(segment: string): string {
  const slug = segment
    .normalize('NFC')
    .replace(/\.md$/i, '')
    .trim()
    .toLowerCase()
    // Separators people actually type between words.
    .replace(/[\s_]+/g, '-')
    // Drop anything that is not a letter, number, dash or dot.
    .replace(/[^\p{L}\p{N}.-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return slug
}

/**
 * Vault-relative path → slug. `Notes/My Note.md` → `notes/my-note`.
 * A file named `index.md` claims its folder: `Notes/index.md` → `notes`.
 */
export function slugifyPath(path: string): string {
  const segments = path.split('/').filter(Boolean).map(slugifySegment).filter(Boolean)
  if (segments.length === 0) return 'untitled'
  if (segments.length > 1 && segments[segments.length - 1] === 'index') segments.pop()
  return segments.join('/')
}

/**
 * Resolve slug collisions deterministically. Two different files can slugify to
 * the same string (`Note.md` and `note.md`, or `A&B` and `A B`). Sorting first
 * means the winner does not depend on filesystem enumeration order, so a build
 * on Linux and a build on macOS produce the same URLs.
 *
 * Returns a path → slug map, and the collisions it had to break, for warning.
 */
export function assignSlugs(paths: readonly string[]): {
  slugs: Map<string, string>
  collisions: { slug: string; paths: string[] }[]
} {
  const claimed = new Map<string, string>() // slug -> winning path
  const slugs = new Map<string, string>()
  const grouped = new Map<string, string[]>()

  for (const path of [...paths].sort()) {
    const base = slugifyPath(path)
    let slug = base
    let n = 2
    while (claimed.has(slug)) slug = `${base}-${n++}`
    claimed.set(slug, path)
    slugs.set(path, slug)
    grouped.set(base, [...(grouped.get(base) ?? []), path])
  }

  const collisions = [...grouped.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([slug, group]) => ({ slug, paths: group }))

  return { slugs, collisions }
}

/** Heading text → anchor id, matching github-slugger (what Astro emits). */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}
