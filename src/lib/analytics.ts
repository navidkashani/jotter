/**
 * One provider's documented `<script>` tag, as data.
 *
 * Pure and DOM-free on purpose. `vitest` runs `environment: 'node'` and there
 * is no jsdom, so anything with a right answer — which origin, which attribute,
 * `defer` or `async` — has to live where a unit test can reach it. What is left
 * in `Analytics.astro` is markup and a dev/prod gate, and neither has a wrong
 * answer to assert against.
 *
 * Every tag below is the vendor's own snippet, unmodified. jotter is a
 * multi-page site: a real navigation loads a real document, so each vendor's
 * automatic pageview fires by itself, correctly, on every page. Quartz builds
 * all of these from JavaScript instead and rewires each one into manual mode —
 * Plausible's `script.manual.js`, GA4's `send_page_view: false`, GoatCounter's
 * `no_onload` — because Quartz is an SPA and the document never reloads. Ported
 * here, that machinery would record *nothing*: manual mode with no router to
 * fire it. The static tag is not the lazy version of Quartz's approach; it is
 * the one that is correct for a site without a router.
 */
import type { JotterConfig } from './config.js'

export interface AnalyticsTag {
  src: string
  /** Everything the provider needs beyond `src`. */
  attrs: Record<string, string>
  /** `async` for the two that document it; the rest defer. */
  async: boolean
  /** GA4 only — the id its init block needs. */
  measurementId?: string
}

/** A configured `host` is joined, not resolved: a reverse proxy may sit on a path. */
const origin = (host: string | undefined, fallback: string) =>
  (host ?? fallback).replace(/\/+$/, '')

/**
 * The tag a provider documents, or `undefined` for `provider: 'none'`.
 *
 * The `id` guard is a second line of defence, not the first: the schema rejects
 * a provider without an `id` at config load, naming the key. It is repeated
 * here because this function is exported and callable without going through
 * `defineConfig`, and a half-built tag is not inert — a gtag.js loader with no
 * measurement id still pulls ~100 KB and records nothing.
 */
export function analyticsTag(analytics: JotterConfig['analytics']): AnalyticsTag | undefined {
  const { provider, id, host } = analytics
  if (provider === 'none' || !id) return undefined

  switch (provider) {
    case 'plausible':
      return {
        src: `${origin(host, 'https://plausible.io')}/js/script.js`,
        attrs: { 'data-domain': id },
        async: false,
      }

    case 'umami':
      /**
       * `cloud.umami.is`, not the `analytics.umami.is` Quartz still ships —
       * that host is stale, and this is exactly the kind of value that rots in
       * silence. Checked against Umami's own docs in August 2026; check again
       * before trusting it.
       *
       * `data-auto-track` is Umami's *default*, so writing it out changes
       * nothing. It is here because Quartz writes it too, and a forker
       * comparing the two tags should not have to wonder what the difference
       * does. Drop it if the byte ever matters.
       */
      return {
        src: `${origin(host, 'https://cloud.umami.is')}/script.js`,
        attrs: { 'data-website-id': id, 'data-auto-track': 'true' },
        async: false,
      }

    case 'goatcounter':
      /**
       * GoatCounter documents a protocol-relative `//gc.zgo.at/count.js`, which
       * is forced to `https` here: the tag only ever ships from a production
       * build, and a protocol-relative URL on an `http://` origin is a
       * downgrade nobody asked for.
       *
       * `host` is the whole endpoint, `https://stats.example.com`, and jotter
       * appends `/count`. Quartz's field of the same name is the *domain
       * suffix* it interpolates the site code into, which is worth knowing if
       * you are copying a value across.
       */
      return {
        src: 'https://gc.zgo.at/count.js',
        attrs: { 'data-goatcounter': `${origin(host, `https://${id}.goatcounter.com`)}/count` },
        async: true,
      }

    case 'fathom':
      return {
        src: 'https://cdn.usefathom.com/script.js',
        attrs: { 'data-site': id },
        async: false,
      }

    case 'cloudflare':
      /**
       * The attribute value is JSON, so it is built with `JSON.stringify`
       * rather than concatenated. Astro escapes it into the attribute as
       * `{&quot;token&quot;:&quot;…&quot;}`, which looks broken in view-source
       * and is not — the browser decodes it before the beacon reads
       * `dataset.cfBeacon`.
       */
      return {
        src: 'https://static.cloudflareinsights.com/beacon.min.js',
        attrs: { 'data-cf-beacon': JSON.stringify({ token: id }) },
        async: false,
      }

    case 'google':
      return {
        src: `https://www.googletagmanager.com/gtag/js?id=${id}`,
        attrs: {},
        async: true,
        measurementId: id,
      }
  }
}
