/**
 * What every jotter plugin needs to know about the document being compiled, and
 * the two facts about Satteri that the whole markdown layer rests on.
 *
 * **Wikilinks are not their own node type.** Satteri parses `[[Target]]` into an
 * ordinary `link` and `![[image.png]]` into an ordinary `image` — the same nodes
 * `[Target](Target)` and `![](image.png)` produce. Nothing on the node says
 * which syntax wrote it, and the two must resolve by different rules: a
 * wikilink resolves against the whole vault by shortest path, a markdown link
 * is a path. The discriminator is the source itself: with `options.position`
 * set, every node carries byte offsets, so slicing `ctx.source` at the node's
 * start and testing for `[[` is exact. It is not a regex over prose — the
 * parser already found the boundaries; we only ask what it read.
 *
 * **The pipe lands in `alt`.** `![[img.png|300]]` arrives as `alt: "300"`, and
 * an unpiped `![[img.png]]` as `alt: "img.png"`. So "was there a pipe at all"
 * is also a question only the source can answer.
 */
import { fileURLToPath } from 'node:url'
import { relative, sep } from 'node:path'

import type { JotterConfig } from '../lib/config.js'
import type { Vault } from '../lib/vault.js'

export interface DocumentContext {
  /** Vault-relative path of the note being compiled, e.g. `notes/Luhmann.md`. */
  fromPath: string
  vault: Vault
  config: JotterConfig
}

/** Minimal shape of the Satteri visitor context the adapters actually use. */
export interface VisitorContext {
  readonly source: string
  readonly data: Record<string, unknown>
  setProperty(node: unknown, key: string, value: unknown): void
  replaceNode(node: unknown, newNode: unknown): void
  removeNode(node: unknown): void
  parent(node: unknown): { type: string; children?: unknown[] } | undefined
  report(input: { message: string; node?: unknown; severity?: 'error' | 'warning' | 'info' }): void
}

export interface Positioned {
  position?: { start: { offset: number }; end: { offset: number } }
}

/** The raw source a node was parsed from. Empty when positions are unavailable. */
export function sourceOf(node: Positioned, ctx: { source: string }): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return start === undefined || end === undefined ? '' : ctx.source.slice(start, end)
}

/** Was this node written as `[[…]]` / `![[…]]` rather than markdown syntax? */
export const isWikiSyntax = (node: Positioned, ctx: { source: string }): boolean => {
  const raw = sourceOf(node, ctx)
  return raw.startsWith('[[') || raw.startsWith('![[')
}

/**
 * Did the author write an explicit `|` in this embed or link? `alt` and the
 * link's children cannot answer it: Satteri fills both in from the target when
 * no pipe was given.
 */
export function wikiPipe(node: Positioned, ctx: { source: string }): string | undefined {
  const raw = sourceOf(node, ctx)
  const inner = /^!?\[\[([^\]]*)\]\]$/.exec(raw)?.[1]
  if (inner === undefined) return undefined
  const pipe = inner.indexOf('|')
  return pipe === -1 ? undefined : inner.slice(pipe + 1).trim()
}

/** Resolve the compiled file back to its vault-relative path. */
export function documentPath(fileURL: URL | undefined, vault: Vault): string | undefined {
  if (!fileURL) return undefined
  const absolute = fileURLToPath(fileURL)
  const rel = relative(vault.root, absolute).split(sep).join('/')
  return rel.startsWith('..') ? undefined : rel
}
