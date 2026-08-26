/**
 * Backlinks and local neighbourhoods, built from the vault's raw edges once per
 * build and shared by every page.
 *
 * Unpublished notes are dropped from *both* directions: a private note must not
 * appear as somebody's backlink, and a link into one is a dead link, not an
 * edge. That is the same rule the wikilink plugin applies while rendering, kept
 * here so the graph and the prose never disagree.
 */
import { resolveLink, type LinkResolution } from './resolve.js'
import type { Vault, VaultNote } from './vault.js'

export interface GraphLink {
  /** Slug of the linked note. */
  slug: string
  title: string
  anchor: string
  /** How the link was labelled in the source, for backlink context. */
  label: string
}

export interface Graph {
  /** Published outgoing links, by note slug. */
  outgoing: Map<string, GraphLink[]>
  /** Published incoming links, by note slug. */
  backlinks: Map<string, GraphLink[]>
  /** Slug to display title, for every published note. */
  titles: Map<string, string>
  /** Notes with no incoming links, for the "orphans" affordance. */
  orphans: string[]
  warnings: string[]
}

export function buildGraph(vault: Vault, mode: LinkResolution = 'shortest'): Graph {
  const outgoing = new Map<string, GraphLink[]>()
  const backlinks = new Map<string, GraphLink[]>()
  const titles = new Map<string, string>()
  const warnings: string[] = []
  const seenAmbiguity = new Set<string>()

  const published = vault.notes.filter((n) => n.published)
  for (const note of published) {
    outgoing.set(note.slug, [])
    backlinks.set(note.slug, [])
    titles.set(note.slug, note.title)
  }

  for (const note of published) {
    const edges = vault.edges.get(note.path) ?? []
    const seen = new Set<string>()

    for (const edge of edges) {
      // Transclusions are rendered inline, so they are not a navigation edge.
      if (edge.embed) continue

      const resolution = resolveLink(edge.raw, note.path, vault, mode)
      if (resolution.status !== 'published') continue

      const target = resolution.note as VaultNote
      if (target.slug === note.slug) continue // self-links are noise in a graph

      if (resolution.ambiguity && !seenAmbiguity.has(edge.raw)) {
        seenAmbiguity.add(edge.raw)
        warnings.push(
          `Ambiguous link "${edge.raw}" in ${note.path} matches ` +
            `${resolution.ambiguity.map((c) => c.path).join(' and ')}. ` +
            `Resolved to ${target.path} (shallowest).`,
        )
      }

      // One edge per pair per direction: a note linking somewhere five times is
      // one relationship, and five identical backlink rows is just noise.
      const pair = `${note.slug} ${target.slug}`
      if (seen.has(pair)) continue
      seen.add(pair)

      outgoing.get(note.slug)?.push({
        slug: target.slug,
        title: target.title,
        anchor: resolution.anchor,
        label: edge.alias ?? target.title,
      })
      backlinks.get(target.slug)?.push({
        slug: note.slug,
        title: note.title,
        anchor: '',
        label: note.title,
      })
    }
  }

  const orphans = published
    .filter((n) => (backlinks.get(n.slug)?.length ?? 0) === 0)
    .map((n) => n.slug)

  return { outgoing, backlinks, titles, orphans, warnings }
}

export interface GraphNode {
  slug: string
  title: string
  /** 0 for the focused note, 1 for a direct neighbour, and so on. */
  depth: number
}

export interface Neighbourhood {
  nodes: GraphNode[]
  edges: { source: string; target: string }[]
}

/**
 * The local graph around one note. Depth 1 is what the rail shows: the note,
 * everything it links to, and everything linking to it.
 */
export function neighbourhood(graph: Graph, slug: string, depth = 1): Neighbourhood {
  const seen = new Map<string, number>([[slug, 0]])
  const edges: { source: string; target: string }[] = []
  const edgeKeys = new Set<string>()
  let frontier = [slug]

  for (let d = 0; d < depth; d++) {
    const next: string[] = []
    for (const current of frontier) {
      const links = [
        ...(graph.outgoing.get(current) ?? []).map((l) => ({ source: current, target: l.slug })),
        ...(graph.backlinks.get(current) ?? []).map((l) => ({ source: l.slug, target: current })),
      ]
      for (const edge of links) {
        const key = `${edge.source} ${edge.target}`
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key)
          edges.push(edge)
        }
        for (const end of [edge.source, edge.target]) {
          if (!seen.has(end)) {
            seen.set(end, d + 1)
            next.push(end)
          }
        }
      }
    }
    frontier = next
  }

  const nodes: GraphNode[] = [...seen.entries()].map(([s, d]) => ({
    slug: s,
    title: graph.titles.get(s) ?? s,
    depth: d,
  }))

  return { nodes, edges }
}
