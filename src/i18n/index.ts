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

const locales: Record<string, Strings> = { en }

/**
 * Add a locale by dropping `src/i18n/<code>.json` beside `en.json` and
 * registering it here. Kept explicit rather than a glob import so an unused
 * translation never reaches the bundle.
 */
const strings: Strings = { ...en, ...(locales[config.locale] ?? {}) }

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
