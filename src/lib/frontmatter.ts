/**
 * Every key jotter reads out of a note's frontmatter, as a schema.
 *
 * Here rather than inline in `src/content.config.ts` for one reason: that file
 * imports `astro:content`, which does not exist outside an Astro build, so a
 * declaration written there is unreachable from vitest. This module imports
 * nothing but `astro/zod` (the same instance `src/lib/config.ts` uses), so the
 * contract below can be *asserted* rather than left to be discovered by a
 * forker whose build died.
 *
 * ## The contract
 *
 * **Everything declared here must accept everything the scan coerces.**
 *
 * The schema and `src/lib/vault.ts` are two answers to the same question, and
 * for a long time they disagreed. `resolveTitle` has always had a
 * `typeof fm === 'number'` branch, `normalizeAliases` has always called
 * `String(a)`, and `frontmatterTags` has always called `String(t)`: three
 * pieces of deliberate coercion that a stricter declaration here made
 * unreachable. `title: 2026` on a yearly review note, or `tags: [2026, reading]`,
 * did not degrade: it failed the build, on a vault Obsidian opens without
 * comment. That is the opposite of what the file this replaces claimed to be
 * (*"a list of keys jotter will use if it finds them"*), and `test/site.test.ts`
 * now walks the two lists against each other so they cannot drift again.
 *
 * ## The three that stay strict, on purpose
 *
 * `publish`, `draft` and `homepage` are booleans and reject anything else.
 * They are the exception because a wrong value in them is not cosmetic:
 * `publish: 'false'` coerced generously is a note the author meant to hide,
 * published, silently: the exact failure the publish gate exists to prevent.
 * A misrouted `/` is the same shape of mistake one key over. Those three
 * degrade *loudly*, naming the key, which everywhere else in jotter is what a
 * privacy or routing decision does.
 */
import { z } from 'astro/zod'

/**
 * The keys `src/components/Frontmatter.astro` prints in a note's header block,
 * in the order it prints them.
 *
 * Here rather than in the component for the reason `analyticsProviders` is in
 * `src/lib/config.ts` rather than in `Analytics.astro`: a test can then assert
 * that every one of them is declared in the schema below *and* has a label in
 * `src/i18n/en.json`. Without that, adding a field to the component is one edit
 * away from a `<dt>` reading `note.field.whatever` on every note page: `t()`
 * returns the key when it cannot find a string.
 */
export const DISPLAYED_FIELDS = ['aliases', 'status', 'source', 'author', 'series'] as const

/**
 * A title, a description or a tag, as YAML actually parses it. `title: 2026`
 * is a number by the time it reaches us, and `resolveTitle` has always been
 * ready for it.
 */
const textish = z.union([z.string(), z.number()])

/**
 * A date, or something `resolveDates` will quietly decline and fall back to git
 * for. `published: true` is the case that makes the boolean necessary: it is
 * common in a vault that used it as a publish flag, `asDate` returns
 * `undefined` for it, and the note simply takes its git date instead.
 */
const dateish = z.union([z.string(), z.date(), z.number(), z.boolean()])

/** Anything `Frontmatter.astro`'s `scalar()` can print, or a list of them. */
const printable = z.union([z.string(), z.number(), z.boolean(), z.date()])
const displayed = z.union([printable, z.array(printable)])

export const noteFrontmatterSchema = z
  .object({
    title: textish.optional(),
    description: textish.optional(),

    /** Both spellings, the way Obsidian and Quartz both accept both. */
    aliases: z.union([textish, z.array(textish)]).optional(),
    alias: z.union([textish, z.array(textish)]).optional(),

    /** A list, a single tag, or a comma-separated string (see `frontmatterTags`). */
    tags: z.union([textish, z.array(textish)]).optional(),

    /**
     * Five spellings each, because `src/lib/dates.ts` reads five each. Only
     * five of the ten used to be declared, which is how `created_at` and
     * `createdAt` came to work by accident of `.passthrough()` rather than on
     * purpose, and `published: true` came to fail the build outright.
     */
    created: dateish.optional(),
    created_at: dateish.optional(),
    createdAt: dateish.optional(),
    published: dateish.optional(),
    date: dateish.optional(),
    updated: dateish.optional(),
    updated_at: dateish.optional(),
    updatedAt: dateish.optional(),
    modified: dateish.optional(),
    lastmod: dateish.optional(),

    /** The strict three. See the docstring above before widening any of them. */
    publish: z.boolean().optional(),
    draft: z.boolean().optional(),
    homepage: z.boolean().optional(),

    /**
     * The URL this note is served at, instead of the one its path derives.
     *
     * Honoured character for character in every `slugs:` mode (no
     * lowercasing, no dashes, no substitutions), which is the semantics
     * Obsidian Publish's own `permalink` property has, and Jekyll's, and
     * Hugo's `url`. The note's derived slug 301s to it.
     *
     * A *list* is accepted, and that is the contract above rather than a
     * flourish: the Open Publish **Quartz** starter writes a note's
     * `legacyUrls` into this key, `legacyUrls` is a list, and a vault it
     * prepared has to keep working here. The first value is the slug; the rest
     * become redirects. See `applyPermalinks` in `src/lib/vault.ts`.
     *
     * jotter's own snapshot layer does **not** write this key.
     * `scripts/fetch-content.mjs` puts old addresses in `oldUrls:` instead,
     * which 301s to the published slug *without moving the note*: the choice
     * Quartz cannot make, because it slugifies every alias and honours only
     * `permalink` character for character. See `docs/open-publish.md`.
     */
    permalink: z.union([textish, z.array(textish)]).optional(),

    /**
     * Addresses this note used to be served at, which should 301 to it.
     *
     * Written by `scripts/fetch-content.mjs` from the snapshot's `legacyUrls`
     * and every rename the plugin has recorded, and read back by
     * `buildRedirects`. It exists as a key of its own rather than as more
     * `aliases:` because the two are not the same thing and were never the same
     * thing: an alias is a *name* the author gave the note, and
     * `Frontmatter.astro` prints it on the page under "Also known as". An old
     * URL is routing data. Merged into `aliases`, every note on a site migrated
     * from Obsidian Publish printed `About/How+to+Communicate` as human
     * metadata.
     *
     * Not in `DISPLAYED_FIELDS`, and it should stay out of it.
     */
    oldUrls: z.union([z.string(), z.array(z.string())]).optional(),

    /**
     * The card a link to this note unfurls as. `socialImage` and `cover` are
     * Quartz's own two spellings; `image` wins. See `src/lib/social.ts`.
     */
    image: z.string().optional(),
    socialImage: z.string().optional(),
    cover: z.string().optional(),

    /**
     * The four `Frontmatter.astro` renders in the note's header block, each
     * with a label in `src/i18n/en.json`. Undeclared until now, which meant
     * four keys drawing visible UI on every note page that no schema, no
     * README and no test mentioned. They work identically; they are simply
     * findable now.
     *
     * `author` is per-note and display-only: it does not reach the feed, whose
     * `dc:creator` is `config.author`, a claim about who publishes the site
     * rather than who wrote one note.
     */
    status: displayed.optional(),
    source: displayed.optional(),
    author: displayed.optional(),
    series: displayed.optional(),
    // `aliases`, the fifth displayed field, is declared with `alias` above.

    /**
     * The base direction of this note's blocks: the escape hatch for the one
     * case first-strong detection gets wrong (`Obsidian یک برنامه است`, a
     * sentence opening with a word from the other script).
     *
     * `rtl` | `ltr` | `auto`, the key and the three values the community
     * Obsidian RTL plugin (esm7) already writes, so a vault that used it keeps
     * working. `auto` means the default per-block behaviour, which is to say
     * the same thing as not setting the key at all.
     *
     * Loose on purpose, unlike the strict three above: a value this schema
     * cannot read is a cosmetic mistake, not a privacy or routing one, and
     * `src/lib/vault.ts` warns about it by name at scan time rather than
     * failing a build over a paragraph's alignment. See `src/lib/bidi.ts`.
     */
    direction: z.string().optional(),
  })
  /**
   * An unknown key is somebody's Dataview field or plugin metadata. It is not
   * an error, and it must not stop the build.
   */
  .passthrough()

export type NoteFrontmatter = z.infer<typeof noteFrontmatterSchema>
