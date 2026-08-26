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

const analyticsProviders = [
  'none',
  'plausible',
  'umami',
  'goatcounter',
  'fathom',
  'cloudflare',
  'google',
  'custom',
] as const

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

    analytics: z
      .object({
        provider: z.enum(analyticsProviders).default('none'),
        /** Site id, domain, or token, depending on the provider. */
        id: z.string().optional(),
        /** Self-hosted endpoint for Plausible/Umami. */
        host: z.url().optional(),
        /** Full script tag source, for `provider: 'custom'`. */
        src: z.string().optional(),
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
