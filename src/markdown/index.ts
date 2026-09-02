/**
 * The Satteri plugin lists.
 *
 * Each entry is a *factory*: Satteri calls it once per document with that
 * document's `fileURL`, which is how every plugin learns which note it is
 * compiling without any global state. A factory returning `null` drops itself
 * from the pipeline for that document: that is how a file outside the vault
 * (Astro's own pages, say) is left completely alone.
 *
 * Order is deliberate:
 *   1. transclude: expands note embeds first, so everything downstream sees
 *      the finished document rather than a placeholder.
 *   2. wikilinks : resolves links and media embeds.
 *   3. callouts  : relabels blockquotes.
 *   4. inline    : the text-level syntaxes, last, so it also reaches text that
 *      transclusion brought in.
 *
 * There is a second list because there is a second phase. `jotterHastPlugins`
 * runs after mdast has become HTML nodes, which is the only phase that can see
 * a *transcluded* paragraph: transclusion splices raw markdown, so the
 * paragraph it produces does not exist while mdast is being walked. See
 * `src/markdown/direction.ts`.
 */
import type { JotterConfig } from '../lib/config.js'
import type { Vault } from '../lib/vault.js'
import { documentPath, type DocumentContext } from './context.js'
import { transclude } from './transclude.js'
import { wikilinks } from './wikilinks.js'
import { callouts } from './callouts.js'
import { inlineSyntax } from './inline.js'
import { direction } from './direction.js'

export interface PluginFactoryContext {
  readonly fileURL: URL | undefined
}

/** Satteri parser features jotter needs. Wikilinks are parsed by the engine. */
export const satteriFeatures = {
  gfm: true,
  wikilinks: true,
  frontmatter: true,
  smartPunctuation: true,
  definitionList: true,
  superscript: true,
  subscript: true,
  headingAttributes: true,
} as const

/**
 * Bind a plugin to the note being compiled, or drop it for a file that is not
 * one. Shared by both lists so "which note is this?" has one answer.
 */
const forDocument =
  (vault: Vault, config: JotterConfig) =>
  <T>(build: (doc: DocumentContext) => T) =>
  (ctx: PluginFactoryContext): T | null => {
    const fromPath = documentPath(ctx.fileURL, vault)
    if (fromPath === undefined) return null
    return build({ fromPath, vault, config })
  }

export function jotterPlugins(vault: Vault, config: JotterConfig) {
  const bind = forDocument(vault, config)

  return [bind(transclude), bind(wikilinks), () => callouts(), bind(inlineSyntax)]
}

/** The hast phase. One plugin, and it needs the note for its `direction:` key. */
export function jotterHastPlugins(vault: Vault, config: JotterConfig) {
  return [forDocument(vault, config)(direction)]
}

export { documentPath }
export type { DocumentContext }
