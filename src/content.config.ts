/**
 * The notes collection.
 *
 * Every field is `.optional()`, deliberately. A vault of bare markdown with no
 * frontmatter at all must build on the first try: that is the difference
 * between a theme you can point at a real Obsidian folder and one that makes
 * you prepare your notes for it first. Nothing in the schema is a requirement;
 * it is a list of keys jotter will *use* if it finds them.
 *
 * The schema itself lives in `src/lib/frontmatter.ts` rather than here, because
 * this file imports `astro:content` and so cannot be reached by vitest. What it
 * declares has to match what `src/lib/vault.ts` coerces, and that is a contract
 * worth a test rather than a hope (see the docstring there).
 *
 * Note that the collection is not where links resolve. It cannot be: the
 * markdown processor runs before `getCollection()` exists. `src/lib/vault.ts`
 * scans the filesystem for that, and this collection supplies the rendered
 * content on top of it.
 */
import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'

import jotter from '../jotter.config'
import { noteFrontmatterSchema } from './lib/frontmatter'

/**
 * `JOTTER_VAULT_OVERRIDE` points the whole pipeline at a different folder
 * without editing config. `scripts/verify-build.mjs` uses it to build a
 * synthetic 1,000-note vault; it has to be honoured here as well as in
 * `astro.config.ts`, or the scan and the collection would read different
 * directories and every note would fail to find its rendered content.
 */
const vaultBase = process.env.JOTTER_VAULT_OVERRIDE ?? `./${jotter.vault}`

const notes = defineCollection({
  loader: glob({
    pattern: '**/*.md',
    base: vaultBase,
    // The id is the vault-relative path, so a collection entry can be matched
    // to the scan's `byPath` index without a second slugify.
    generateId: ({ entry }) => entry,
  }),
  schema: noteFrontmatterSchema,
})

export const collections = { notes }
