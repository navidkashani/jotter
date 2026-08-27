/**
 * One build-wide view of the site, assembled once and imported by every page.
 *
 * Pages must never call `scanVault` themselves: the scan is memoized, but the
 * graph, tree and tag rollups on top of it are not free, and a 1,000-note vault
 * rebuilding them per page is the difference between a fast build and a slow
 * one.
 */
import { resolve } from 'node:path'

import jotter from '../../jotter.config'
import { scanVault, homepageNote, type VaultNote } from './vault.js'
import { buildGraph } from './graph.js'
import { buildTree, folders } from './tree.js'
import { tagTree, expandTag } from './tags.js'
import { buildRedirects } from './redirects.js'

export const config = jotter

/**
 * `astro.config.ts` injects the resolved absolute path. The fallback is for
 * anything importing this module outside an Astro build, where `cwd` is the
 * project root.
 */
const vaultRoot: string =
  import.meta.env?.JOTTER_VAULT_ROOT ?? resolve(process.cwd(), jotter.vault)

export const vault = scanVault({ root: vaultRoot, publishGate: jotter.publishGate })

export const graph = buildGraph(vault, jotter.linkResolution)

/** Published notes only. Nothing downstream should ever see the others. */
export const notes: VaultNote[] = vault.notes.filter((n) => n.published)

/** Newest first, the order a garden's "recently updated" wants. */
export const byUpdated = [...notes].sort(
  (a, b) => b.dates.updated.getTime() - a.dates.updated.getTime(),
)

export const tree = buildTree(notes)
export const allFolders = folders(tree)
export const tags = tagTree(notes)

/** Every tag, expanded, mapped to the notes carrying it or anything beneath it. */
export const notesByTag = (() => {
  const map = new Map<string, VaultNote[]>()
  for (const note of notes) {
    for (const tag of new Set(note.tags.flatMap(expandTag))) {
      const existing = map.get(tag)
      if (existing) existing.push(note)
      else map.set(tag, [note])
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => b.dates.updated.getTime() - a.dates.updated.getTime())
  }
  return map
})()

/**
 * The note claiming `/`. Resolved in `src/lib/vault.ts` rather than here,
 * because `astro.config.ts` needs the same answer for the feed and there must
 * be exactly one.
 */
export const homepage: VaultNote | undefined = homepageNote(vault, config.homepage)

export const backlinksFor = (slug: string) => graph.backlinks.get(slug) ?? []
export const outgoingFor = (slug: string) => graph.outgoing.get(slug) ?? []

/**
 * Redirects generated from `aliases:`, plus whatever the config adds. Emitted
 * as `_redirects` and `vercel.json` by the vault integration; exposed here so a
 * page can link an alias if it wants to.
 */
export const aliasRedirects: Record<string, string> = buildRedirects({
  notes,
  taken: [...notes.map((n) => n.slug), ...allFolders.map((f) => f.slug), 'notes', 'tags', '404'],
  extra: config.redirects,
})
