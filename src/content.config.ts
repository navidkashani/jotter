/**
 * The notes collection.
 *
 * Every field is `.optional()`, deliberately. A vault of bare markdown with no
 * frontmatter at all must build on the first try — that is the difference
 * between a theme you can point at a real Obsidian folder and one that makes
 * you prepare your notes for it first. Nothing here is a requirement; it is a
 * list of keys jotter will *use* if it finds them.
 *
 * Note that the collection is not where links resolve. It cannot be: the
 * markdown processor runs before `getCollection()` exists. `src/lib/vault.ts`
 * scans the filesystem for that, and this collection supplies the rendered
 * content on top of it.
 */
import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'

import jotter from '../jotter.config'

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
  schema: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      aliases: z.union([z.string(), z.array(z.string())]).optional(),
      alias: z.union([z.string(), z.array(z.string())]).optional(),
      tags: z.union([z.string(), z.array(z.string())]).optional(),
      created: z.union([z.string(), z.date(), z.number()]).optional(),
      updated: z.union([z.string(), z.date(), z.number()]).optional(),
      date: z.union([z.string(), z.date(), z.number()]).optional(),
      modified: z.union([z.string(), z.date(), z.number()]).optional(),
      lastmod: z.union([z.string(), z.date(), z.number()]).optional(),
      publish: z.boolean().optional(),
      draft: z.boolean().optional(),
      homepage: z.boolean().optional(),
      // The card a link to this note unfurls as. `socialImage` and `cover` are
      // Quartz's own two spellings of the same key, accepted the way `alias`
      // is accepted beside `aliases`; `image` wins. See `src/lib/social.ts`.
      image: z.string().optional(),
      socialImage: z.string().optional(),
      cover: z.string().optional(),
    })
    // An unknown key is somebody's Dataview field or plugin metadata. It is
    // not an error, and it must not stop the build.
    .passthrough(),
})

export const collections = { notes }
