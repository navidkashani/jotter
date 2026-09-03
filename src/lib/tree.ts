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
  /** Left out of the sidebar. Still built, still routed, still reachable. */
  hidden?: boolean
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
  /** Left out of the sidebar, along with everything under it. See `hidden`. */
  hidden?: boolean
}

export type TreeEntry = TreeNote | TreeFolder

/**
 * The sidebar arrangement from the published snapshot: `config.navOrder` and
 * `config.navHidden`.
 *
 * Both name **slugs**, and a folder is named by the slug of its index page, so
 * the folder served at `/notes` is `notes/index` here. That indirection is the
 * plugin's contract rather than jotter's preference, and it earns its keep: a
 * folder and a note can want the same URL, which `shadowedFolders` below exists
 * because of, and `notes` alone could not tell them apart.
 */
export interface NavArrangement {
  /** Slugs in sidebar order, for the parents somebody arranged. */
  order: readonly string[]
  /** Slugs to leave out of the sidebar. */
  hidden: readonly string[]
}

const NO_ARRANGEMENT: NavArrangement = { order: [], hidden: [] }

/** What the arrangement calls this entry. A folder answers for its index page. */
const navKey = (entry: TreeEntry): string =>
  entry.kind === 'folder' ? `${entry.slug}/index` : entry.slug

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
 * All of this is the *default*, and it is what a parent nobody arranged keeps.
 * An Open Publish snapshot can carry an explicit order, and where it does, that
 * order wins outright: somebody who dragged a note above a folder meant it, and
 * so did somebody who dragged one to the top of the root. See `NavArrangement`.
 *
 * What still cannot be had is Obsidian Publish's own hand-dragged order. That
 * lives in its server-side site options rather than in `.obsidian/publish.json`,
 * so nothing can import it; what arrives here was arranged in Open Publish. See
 * `docs/open-publish.md`.
 */
const compare = (a: TreeEntry, b: TreeEntry, notesFirst: boolean, rank: Map<string, number>) => {
  // An arranged pair is ordered by the arrangement and nothing else. Arranged
  // beats unarranged, and both beat the kind rule below, which is the whole
  // point of an explicit order.
  const rankA = rank.get(navKey(a))
  const rankB = rank.get(navKey(b))
  if (rankA !== undefined && rankB !== undefined) return rankA - rankB
  if (rankA !== undefined) return -1
  if (rankB !== undefined) return 1

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
  /**
   * `config.navOrder` and `config.navHidden`: the sidebar somebody arranged in
   * Obsidian, or nothing at all, which is the ordinary case.
   *
   * Hiding marks entries rather than dropping them, and that is the difference
   * between this and a generator whose filter only feeds a sidebar. This tree
   * also generates routes: drop a folder here and its page stops existing,
   * which would turn "leave it out of the navigation" into "unpublish it and
   * everything under it". `NavTree.astro` is what skips them.
   */
  arrangement: NavArrangement = NO_ARRANGEMENT,
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

  /**
   * Every folder this tree will have, worked out before any note is placed.
   *
   * Needed up front because of `homeFor` below, which has to ask whether a
   * folder exists before the note that would create it has been reached.
   */
  const folderPaths = new Set<string>()
  for (const note of notes) {
    const segments = note.path.split('/')
    for (let i = 1; i < segments.length; i++) folderPaths.add(segments.slice(0, i).join('/'))
  }
  const folderBySlug = new Map<string, string>()
  for (const path of folderPaths) folderBySlug.set(slugFor(path, style), path)

  /**
   * Which folder draws this note.
   *
   * Its own folder, except for a **folder note**: a note whose slug *is* a
   * folder's slug, which is `About/About.md` carrying `permalink: about`. That
   * note and the folder both want `/about`; the note wins the URL and the
   * folder gets no index page, which `[...slug].astro` has always done. What
   * was missing is that the sidebar drew it twice, once as a page above the
   * folders and once as the folder beside it, both linking to the same place.
   *
   * It belongs in the folder, which is where Obsidian shows it and where
   * Obsidian Publish publishes it.
   *
   * The reason it was ever anywhere else is worth keeping written down. On an
   * Open Publish build every note is written to disk **at its slug**, so this
   * file arrives as `about.md` at the vault root and the folder it belongs to
   * is nowhere in its path any more. Grouping by path is right for a local
   * vault and loses exactly this one case on a published one, so the slug is
   * what has to answer it.
   */
  const homeFor = (note: VaultNote): string =>
    folderBySlug.get(note.slug) ?? note.path.split('/').slice(0, -1).join('/')

  for (const note of notes) {
    const home = homeFor(note)
    folderFor(home).children.push({
      kind: 'note',
      title: note.title,
      slug: note.slug,
      path: note.path,
      updated: note.dates.updated,
    })

    // Count into every ancestor, so a collapsed folder still says how much is
    // inside it. Counted from where the note is drawn rather than from its
    // path, or a folder note would be tallied outside the folder it is in.
    const segments = home === '' ? [] : home.split('/')
    for (let i = segments.length; i > 0; i--) {
      const ancestor = folders.get(segments.slice(0, i).join('/'))
      if (ancestor) ancestor.count++
    }
    root.count++
  }

  const rank = new Map(arrangement.order.map((slug, index) => [slug, index]))
  const hidden = new Set(arrangement.hidden)

  const sortDeep = (entries: TreeEntry[], atRoot: boolean): TreeEntry[] => {
    entries.sort((a, b) => compare(a, b, atRoot, rank))
    for (const entry of entries) {
      if (hidden.has(navKey(entry))) entry.hidden = true
      if (entry.kind === 'folder') sortDeep(entry.children, false)
    }
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
 *
 * Neither is anything hidden, for the same reason twice over: it is not in the
 * navigation, and this chain is supposed to be the navigation's order. A hidden
 * note still has its own page and still has neighbours; it simply stops being
 * anybody else's "next".
 */
export function neighbours(
  entries: readonly TreeEntry[],
): Map<string, { previous?: string; next?: string }> {
  const pairs = new Map<string, { previous?: string; next?: string }>()

  const walk = (children: readonly TreeEntry[]): void => {
    const notes = children.filter(
      (child): child is TreeNote => child.kind === 'note' && !child.hidden,
    )
    notes.forEach((note, i) => {
      pairs.set(note.slug, { previous: notes[i - 1]?.slug, next: notes[i + 1]?.slug })
    })
    // A hidden folder is not walked at all: nothing inside it is in the
    // navigation, so nothing inside it is anybody's next either.
    for (const child of children) {
      if (child.kind === 'folder' && !child.hidden) walk(child.children)
    }
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
