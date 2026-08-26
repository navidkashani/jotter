/**
 * The folder tree behind the sidebar.
 *
 * Folders are derived from note paths rather than read from disk, so a folder
 * holding nothing published never appears. Every folder gets a page of its own
 * (`/notes/`, `/notes/nested/`), which is what makes a tree parent clickable
 * instead of a label that only toggles.
 */
import { slugifyPath } from './slug.js'
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
  /** Display name: the folder's own segment. */
  name: string
  /** Vault-relative folder path, e.g. `notes/nested`. */
  path: string
  slug: string
  children: TreeEntry[]
  /** Notes anywhere beneath this folder. */
  count: number
}

export type TreeEntry = TreeNote | TreeFolder

const compare = (a: TreeEntry, b: TreeEntry) => {
  // Folders first, then notes, each alphabetical: the shape people expect from
  // a file tree, and stable across platforms.
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
  const aName = a.kind === 'folder' ? a.name : a.title
  const bName = b.kind === 'folder' ? b.name : b.title
  return aName.localeCompare(bName)
}

export function buildTree(notes: readonly VaultNote[]): TreeEntry[] {
  const root: TreeFolder = { kind: 'folder', name: '', path: '', slug: '', children: [], count: 0 }
  const folders = new Map<string, TreeFolder>([['', root]])

  const folderFor = (path: string): TreeFolder => {
    const existing = folders.get(path)
    if (existing) return existing

    const segments = path.split('/')
    const name = segments[segments.length - 1]
    const parent = folderFor(segments.slice(0, -1).join('/'))
    const folder: TreeFolder = {
      kind: 'folder',
      name,
      path,
      slug: slugifyPath(path),
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

  const sortDeep = (entries: TreeEntry[]): TreeEntry[] => {
    entries.sort(compare)
    for (const entry of entries) if (entry.kind === 'folder') sortDeep(entry.children)
    return entries
  }

  return sortDeep(root.children)
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

/** Is `slug` inside this folder (or is it the folder)? Drives `<details open>`. */
export const contains = (folder: TreeFolder, slug: string): boolean =>
  slug === folder.slug || slug.startsWith(`${folder.slug}/`)
