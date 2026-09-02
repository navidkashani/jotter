/**
 * The folder tree behind the sidebar.
 *
 * Folders are derived from note paths rather than read from disk, so a folder
 * holding nothing published never appears. Every folder gets a page of its own
 * (`/notes/`, `/notes/nested/`), which is what makes a tree parent clickable
 * instead of a label that only toggles.
 */
import { slugFor, type SlugStyle } from './slug.js'
import type { VaultNote } from './vault.js'

export interface TreeNote {
  kind: 'note'
  title: string
  slug: string
  path: string
  updated: Date
}

export interface TreeFolder {
  kind: 'folder'
  /** Display name: `config.folderNames[path]`, else the folder's own segment. */
  name: string
  /** Vault-relative folder path, e.g. `notes/nested`. */
  path: string
  slug: string
  children: TreeEntry[]
  /** Notes anywhere beneath this folder. */
  count: number
}

export type TreeEntry = TreeNote | TreeFolder

/**
 * Alphabetical within a kind; which kind comes first depends on where you are.
 *
 * **Inside a folder**, folders first: the shape people expect from a file tree.
 *
 * **At the root**, notes first, and that asymmetry is the point rather than an
 * oversight. The loose notes at the top of a vault are its front doors, and
 * they are exactly the ones a reader is looking for: Welcome, Now, Start here.
 * Sorted under the folders they sat at the *bottom* of the sidebar, below every
 * folder in the vault, which is where Obsidian Publish never puts them and
 * where no wiki puts its front page.
 *
 * This is not the whole of what Obsidian Publish does. That is a hand-dragged
 * order stored in its server-side site options, not in `.obsidian/publish.json`,
 * so no plugin can import it and no generator can reproduce it. See
 * `docs/open-publish.md`. This is the part that can be had for free.
 */
const compare = (a: TreeEntry, b: TreeEntry, notesFirst: boolean) => {
  if (a.kind !== b.kind) {
    const folderIsFirst = a.kind === 'folder' ? -1 : 1
    return notesFirst ? -folderIsFirst : folderIsFirst
  }
  const aName = a.kind === 'folder' ? a.name : a.title
  const bName = b.kind === 'folder' ? b.name : b.title
  return aName.localeCompare(bName)
}

/**
 * `style` is not optional in practice, and `contains()` at the bottom of this
 * file is why: it tests `slug.startsWith(folder.slug + '/')`, so a folder
 * slugged `wisdom-approaches` above a note slugged `Wisdom+&+Approaches/…`
 * matches nothing: the sidebar's `<details open>` and the current-page
 * highlight both go quiet, with no error anywhere. Both callers pass
 * `vault.slugs`.
 *
 * A note that a `permalink:` moved *out* of its folder stops matching too, and
 * that is correct: it is no longer served from under that folder's URL.
 */
export function buildTree(
  notes: readonly VaultNote[],
  style: SlugStyle,
  /**
   * `config.folderNames`: what to call a folder whose path on disk is not its
   * name. Empty for an ordinary vault; on an Open Publish build it carries the
   * real names back, because there every note is written to its slug and the
   * folder a path implies is `wisdom-approaches`, not `Wisdom & Approaches`.
   *
   * Applied here rather than at each of the four places a folder name is drawn
   * (the sidebar, the breadcrumb, the folder page's `<h1>`, the child-folder
   * cards), so there is one answer and `compare` below sorts by the name a
   * reader actually sees.
   */
  folderNames: Record<string, string> = {},
): TreeEntry[] {
  const root: TreeFolder = { kind: 'folder', name: '', path: '', slug: '', children: [], count: 0 }
  const folders = new Map<string, TreeFolder>([['', root]])

  const folderFor = (path: string): TreeFolder => {
    const existing = folders.get(path)
    if (existing) return existing

    const segments = path.split('/')
    const name = folderNames[path] ?? segments[segments.length - 1]
    const parent = folderFor(segments.slice(0, -1).join('/'))
    const folder: TreeFolder = {
      kind: 'folder',
      name,
      path,
      slug: slugFor(path, style),
      children: [],
      count: 0,
    }
    folders.set(path, folder)
    parent.children.push(folder)
    return folder
  }

  for (const note of notes) {
    const segments = note.path.split('/')
    const parent = folderFor(segments.slice(0, -1).join('/'))
    parent.children.push({
      kind: 'note',
      title: note.title,
      slug: note.slug,
      path: note.path,
      updated: note.dates.updated,
    })

    // Count into every ancestor, so a collapsed folder still says how much is
    // inside it.
    for (let i = segments.length - 1; i > 0; i--) {
      const ancestor = folders.get(segments.slice(0, i).join('/'))
      if (ancestor) ancestor.count++
    }
    root.count++
  }

  const sortDeep = (entries: TreeEntry[], atRoot: boolean): TreeEntry[] => {
    entries.sort((a, b) => compare(a, b, atRoot))
    for (const entry of entries) if (entry.kind === 'folder') sortDeep(entry.children, false)
    return entries
  }

  return sortDeep(root.children, true)
}

/**
 * Previous and next for every note, as slugs.
 *
 * **Siblings under the same folder**, in the order `buildTree` already sorted
 * them, which is the order the sidebar draws. The pair this replaces indexed
 * into the flat published list, whose order is a lexicographic sort of the
 * whole vault path: from `/welcome` at the root of a 96-note site, "Previous"
 * was `/team-productivity/hire-managers-of-one`. Nothing was broken (every
 * target resolved); it simply described a sequence no reader could see.
 *
 * Derived from the tree rather than sorted again here, deliberately. A second
 * ordering is a second answer, and the footer disagreeing with the sidebar
 * about what comes next is worse than either order on its own.
 *
 * Folders are not in the chain. A folder is a listing, not the next thing to
 * read, and stepping into one would make the sequence depend on which folder
 * you happened to be in.
 */
export function neighbours(
  entries: readonly TreeEntry[],
): Map<string, { previous?: string; next?: string }> {
  const pairs = new Map<string, { previous?: string; next?: string }>()

  const walk = (children: readonly TreeEntry[]): void => {
    const notes = children.filter((child): child is TreeNote => child.kind === 'note')
    notes.forEach((note, i) => {
      pairs.set(note.slug, { previous: notes[i - 1]?.slug, next: notes[i + 1]?.slug })
    })
    for (const child of children) if (child.kind === 'folder') walk(child.children)
  }

  walk(entries)
  return pairs
}

/** Every folder in the tree, flattened, for route generation. */
export function folders(entries: readonly TreeEntry[]): TreeFolder[] {
  const out: TreeFolder[] = []
  for (const entry of entries) {
    if (entry.kind !== 'folder') continue
    out.push(entry)
    out.push(...folders(entry.children))
  }
  return out
}

/**
 * Folders whose slug a note already owns.
 *
 * `src/pages/[...slug].astro` resolves the clash by giving the URL to the note,
 * which is the right answer and a surprising one: the sidebar goes on listing
 * the folder, with its note count, and following it lands on the note instead
 * of a listing. On `navidk.com` the folder `About/` and the note `About/About.md`
 * carrying `permalink: about` collide exactly this way.
 *
 * Here rather than inline in `astro.config.ts` so it can be tested, and so the
 * resolution and the report cannot drift apart: both read this list.
 */
export function shadowedFolders(
  entries: readonly TreeEntry[],
  notes: readonly VaultNote[],
): { folder: string; slug: string; note: string }[] {
  const bySlug = new Map(notes.map((note) => [note.slug, note]))
  return folders(entries).flatMap((folder) => {
    const note = bySlug.get(folder.slug)
    return note ? [{ folder: folder.path, slug: folder.slug, note: note.path }] : []
  })
}

/** Is `slug` inside this folder (or is it the folder)? Drives `<details open>`. */
export const contains = (folder: TreeFolder, slug: string): boolean =>
  slug === folder.slug || slug.startsWith(`${folder.slug}/`)
