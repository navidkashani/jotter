/**
 * The typed config a forker owns.
 *
 * Zod comes from `astro/zod` rather than a `zod` dependency of our own: Astro
 * re-exports it, and using the same instance guarantees API parity with content
 * collections. Installing `zod` separately is how you end up with two Zod
 * majors in one build.
 *
 * Every field has a default. `jotter.config.ts` may be `defineConfig({})` and
 * the site still builds.
 */
import { z } from 'astro/zod'

/**
 * Exported so a test can assert that every member has a tag in
 * `src/lib/analytics.ts`. Adding a provider here without a mapping there would
 * otherwise be a silent `undefined` — a configured site emitting nothing.
 */
export const analyticsProviders = [
  'none',
  'plausible',
  'umami',
  'goatcounter',
  'fathom',
  'cloudflare',
  'google',
] as const

/**
 * The three with a self-hosted mode. `host` on any of the other four is not a
 * preference jotter declines to honour, it is a misunderstanding — Fathom,
 * Cloudflare and Google have no self-hosted endpoint to point at — so it is
 * rejected below rather than ignored.
 */
const selfHostable: readonly string[] = ['plausible', 'umami', 'goatcounter']

export const jotterConfigSchema = z
  .object({
    /** Shown in the header and as the `<title>` suffix. */
    title: z.string().default('Slipbox'),
    description: z.string().default(''),
    /** Absolute site URL. Required for sitemap, RSS and canonical links. */
    url: z.url().optional(),
    author: z.string().default(''),

    /** BCP-47 tag, e.g. `en`, `de`, `ar`. Sets `<html lang>`. */
    locale: z.string().default('en'),
    dir: z.enum(['ltr', 'rtl']).default('ltr'),

    /** Vault location, relative to the project root. */
    vault: z.string().default('src/content/notes'),

    /** Reading layout. There is deliberately no reader-facing toggle. */
    layout: z.enum(['column', 'panels']).default('column'),
    /** Sidebar mode. Both templates ship. */
    nav: z.enum(['tree', 'tags', 'none']).default('tree'),

    /**
     * Obsidian's default is shortest-path. Quartz defaults to `absolute`, which
     * is why links that work in the app break on a Quartz site.
     */
    linkResolution: z.enum(['shortest', 'absolute', 'relative']).default('shortest'),

    /** `all` publishes unless a note opts out; `opt-in` requires `publish: true`. */
    publishGate: z.enum(['all', 'opt-in']).default('all'),

    /** Slug of the note that should claim `/`. Falls back to a generated landing page. */
    homepage: z.string().optional(),

    /** Obsidian's own default is `false`: a single newline becomes a line break. */
    strictLineBreaks: z.boolean().default(false),

    images: z.enum(['optimize', 'passthrough']).default('optimize'),

    /** Emitted into robots.txt and headers, and suppresses the sitemap. */
    noIndex: z.boolean().default(false),

    /**
     * Each feature that is off ships *no JavaScript at all*, because the island
     * is not rendered rather than hidden. A build assertion verifies it.
     */
    features: z
      .object({
        toc: z.boolean().default(true),
        backlinks: z.boolean().default(true),
        tags: z.boolean().default(true),
        themeToggle: z.boolean().default(true),
        /** v2 */
        graph: z.boolean().default(false),
        search: z.boolean().default(false),
        hoverPreview: z.boolean().default(false),
        rss: z.boolean().default(false),
      })
      .prefault({}),

    /** Transclusion depth before jotter stops and says so. */
    transcludeDepth: z.number().int().min(0).max(6).default(3),

    /**
     * Off by default, and the only switch in jotter that adds a request to
     * somebody else's server. Both refinements exist so that a misconfiguration
     * is a build error naming the key rather than a site that silently collects
     * nothing — degrade loudly, the way the vault integration already does.
     *
     * There is deliberately no `custom` provider and no `src`. A field taking
     * an arbitrary script URL is one the origin assertion in
     * `scripts/verify-build.mjs` cannot check, and an assertion with a hole
     * shaped like "anything the user typed" is not an assertion. Paste your own
     * snippet into `src/layouts/Base.astro` instead.
     */
    analytics: z
      .object({
        provider: z.enum(analyticsProviders).default('none'),
        /** Site id, domain, or token, depending on the provider. */
        id: z.string().optional(),
        /** Self-hosted endpoint for Plausible, Umami or GoatCounter. */
        host: z.url().optional(),
      })
      /**
       * Strict here as well as at the root, because the root's `.strict()` does
       * *not* cascade into a nested object: without this, `src:` left behind
       * from a pre-1.0 config would be stripped in silence rather than named.
       */
      .strict()
      .refine((a) => a.provider === 'none' || !!a.id, {
        path: ['id'],
        message: 'is required unless `provider` is \'none\'',
      })
      .refine((a) => !a.host || selfHostable.includes(a.provider), {
        path: ['host'],
        message: 'applies to plausible, umami and goatcounter only; the rest are vendor-hosted',
      })
      .prefault({}),

    /** Extra redirects, on top of the ones `aliases:` generates. */
    redirects: z.record(z.string(), z.string()).default({}),
  })
  .strict()

export type JotterConfig = z.infer<typeof jotterConfigSchema>
export type JotterConfigInput = z.input<typeof jotterConfigSchema>

/**
 * Parse and validate. Throws with the offending keys named, because a config
 * error found at build time should not require reading this file to fix.
 */
export function defineConfig(input: JotterConfigInput = {}): JotterConfig {
  const result = jotterConfigSchema.safeParse(input)
  if (result.success) return result.data

  const issues = result.error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)'
      return `  ${path}: ${issue.message}`
    })
    .join('\n')

  throw new Error(
    `jotter.config.ts is not valid:\n${issues}\n\n` +
      `Every field is optional; remove the offending key to take its default.`,
  )
}

/** Feature flags, resolved. Handy for the "feature off means no JS" assertion. */
export const enabledFeatures = (config: JotterConfig): string[] =>
  Object.entries(config.features)
    .filter(([, on]) => on)
    .map(([name]) => name)
