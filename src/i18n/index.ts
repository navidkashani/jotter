/**
 * UI strings. Every piece of chrome text in jotter comes from here, so a
 * translation is a JSON file rather than a hunt through 30 components.
 *
 * `locale` in `jotter.config.ts` picks the file; English is the fallback for
 * any key a translation has not covered yet, so a partial translation degrades
 * to mixed language rather than to blank chrome.
 */
import en from './en.json'
import { config } from '../lib/site.js'

type Strings = Record<string, string>

/**
 * Add a locale by dropping `src/i18n/<code>.json` beside `en.json`. That is the
 * whole procedure: nothing is registered here, so a translation is a file you
 * add rather than a file you add *and* a line you edit in a file upstream owns.
 * Which matters more than the keystroke it saves: that line was in a tracked
 * file every update touches, so shipping a translation meant taking a merge
 * conflict for it later.
 *
 * The pattern must be a static string literal; Vite resolves it at build time.
 *
 * The explicit list this replaced was justified as keeping an unused
 * translation out of the bundle, and that reason does not hold: this module is
 * imported only from `.astro` frontmatter, so every line of it runs during the
 * build and none of it is shipped to a reader. What a glob adds to `dist/` is
 * nothing at all.
 */
const locales: Record<string, Strings> = Object.fromEntries(
  Object.entries(
    import.meta.glob('./*.json', { eager: true }) as Record<string, { default: Strings }>,
  ).map(([path, module]) => [path.slice('./'.length, -'.json'.length), module.default]),
)

/**
 * The translation for a tag, trying the whole tag before its language alone.
 *
 * `config.locale` is a BCP-47 tag and the Open Publish plugin sends
 * region-qualified ones: `fa-IR`, not `fa`. An exact-match lookup would miss a
 * `fa.json` sitting right there, so a Persian site would silently render
 * English chrome. Region-specific files still win when one exists, which is
 * what `pt-BR` beside a general `pt` is for.
 */
function stringsFor(locale: string): Strings {
  return locales[locale] ?? locales[locale.split('-')[0]] ?? {}
}

const strings: Strings = { ...en, ...stringsFor(config.locale) }

/** Look up a string, interpolating `{name}` placeholders. */
export function t(key: keyof typeof en | string, values?: Record<string, string | number>): string {
  const template = strings[key]
  if (template === undefined) {
    // A missing key is a bug in the theme, not something to hide from the page.
    console.warn(`[jotter] Missing i18n string: ${key}`)
    return key
  }
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    name in values ? String(values[name]) : match,
  )
}

/** Dates in the site's locale, spelled out rather than numeric. */
export const formatDate = (date: Date): string =>
  new Intl.DateTimeFormat(config.locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)

export const isoDate = (date: Date): string => date.toISOString().slice(0, 10)
