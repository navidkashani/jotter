/**
 * The site's absolute URL, from whatever the host happens to inject.
 *
 * jotter needs one for the sitemap, the canonical link, `og:image` and RSS,
 * and needs it to be a *whole* URL. `src/lib/config.ts` declares `url` as
 * `z.url()`, so the bare host the Quartz port returns (`notes.example.com`)
 * fails the config parse outright. That is the one deliberate difference from
 * the reference implementation: everything here comes back with a scheme, or
 * comes back `undefined`.
 *
 * `undefined` rather than `''` for the same reason the reference gives: an
 * empty string is falsy in some places and a valid-looking value in others,
 * and `z.url()` would reject it with a message about the config file rather
 * than about the missing environment variable that actually caused it.
 */

/**
 * A host or URL from the environment, as an absolute URL, or `undefined` when
 * there is nothing usable there.
 *
 * Vercel's variables are bare hosts (`my-site.vercel.app`), Cloudflare's and
 * Netlify's already carry `https://`. Both shapes arrive here, so the scheme is
 * added when it is missing rather than assumed either way.
 */
function absolute(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return undefined
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    return undefined
  }
  if (!url.host) return undefined
  // `new URL('https://x.com').href` is `https://x.com/`; a site URL reads
  // better without the trailing slash, and Astro accepts either.
  return url.pathname === '/' ? url.origin : `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * Workers Builds is the one host that tells the build nothing about where the
 * site will be served.
 *
 * The reference implementation *fails* the build here, because Quartz falls
 * back to `example.com` and ships a feed, a sitemap and a 404 page pointing at
 * a domain the user does not own. jotter has no such fallback: with no `url`
 * the sitemap integration is never registered, `robots.txt` carries no
 * `Sitemap:` line, and pages carry no canonical. The site is smaller, not
 * wrong, so this is a warning, and a build that would otherwise succeed still
 * does.
 */
export const NO_SITE_URL_ON_WORKERS =
  'This build is running on Cloudflare Workers Builds, which does not tell the build what ' +
  'address the site is served at. Without one, jotter emits no sitemap and no canonical ' +
  'links. Set OP_SITE_URL to your own address, for example https://notes.example.com, under ' +
  'Settings > Variables and Secrets on the Worker, then build again.'

/**
 * Cloudflare Pages' `CF_PAGES_URL` on a deployment that has no alias: a fresh
 * eight-hex-digit subdomain, minted per deploy.
 *
 * `2f8bfad6.notes.pages.dev`, never `notes.pages.dev`. Matching on the shape is
 * the only way to tell them apart, because Pages injects exactly five variables
 * (`CI`, `CF_PAGES`, `CF_PAGES_COMMIT_SHA`, `CF_PAGES_BRANCH`, `CF_PAGES_URL`)
 * and **none of them carries the stable `<project>.pages.dev` alias**. There is
 * nothing to derive it from, so it has to be asked for.
 */
const PAGES_DEPLOYMENT_HOST = /^https?:\/\/[0-9a-f]{8}\./i

/**
 * The one failure in this file, and it is a failure rather than a warning
 * because of what the wrong answer costs.
 *
 * `CF_PAGES_URL` on a deployment with no alias is the *deployment's* address,
 * and Cloudflare serves that host with `x-robots-tag: noindex`. Written into
 * the config it becomes every page's `<link rel="canonical">`, its `og:url`,
 * every entry in `sitemap-0.xml` and the `Sitemap:` line in `robots.txt`: the
 * whole site telling search engines that the real version of each page lives at
 * a host they are forbidden to index. Pages that drop out of the index are the
 * documented outcome of that conflict, which is the exact opposite of what
 * preserving somebody's URLs was for.
 *
 * A warning would not do. This shipped to a production site behind a build log
 * that said nothing, which is precisely how a warning performs.
 */
export const NO_SITE_URL_ON_PAGES =
  'This build is running on Cloudflare Pages, and the only address it was given (CF_PAGES_URL) ' +
  'is this deployment\'s own hash subdomain, which changes on every deploy and which Cloudflare ' +
  'serves with "x-robots-tag: noindex". Used as the site URL it would put a canonical link, an ' +
  'og:url and a sitemap on every page naming a host search engines are forbidden to index, and ' +
  'the usual result of that contradiction is the site dropping out of the index. Pages injects ' +
  'no variable carrying the stable <project>.pages.dev alias, so it cannot be worked out here. ' +
  'Set OP_SITE_URL to the address readers actually use, for example https://notes.example.com ' +
  'or https://<project>.pages.dev, under Settings > Variables and secrets in the Pages project, ' +
  'for the Production and Preview environments both, then deploy again.'

/**
 * `{ url, warning, error }`: the URL to write into the generated config, and
 * anything the person reading the build log should be told about how it was
 * found. `error` is set only when continuing would be worse than stopping; the
 * caller fails the build on it.
 */
export function resolveSiteUrl(env = process.env) {
  // Set this yourself to override everything, e.g. for a custom domain.
  const explicit = absolute(env.OP_SITE_URL)
  if (explicit) return { url: explicit }

  if (PAGES_DEPLOYMENT_HOST.test(String(env.CF_PAGES_URL ?? '').trim())) {
    return { url: undefined, error: NO_SITE_URL_ON_PAGES }
  }

  const url =
    absolute(env.CF_PAGES_URL) ?? // Cloudflare Pages
    absolute(env.DEPLOY_PRIME_URL) ?? // Netlify (branch and deploy previews)
    absolute(env.URL) ?? // Netlify (production)
    absolute(env.VERCEL_PROJECT_PRODUCTION_URL) ?? // Vercel (stable)
    absolute(env.VERCEL_URL) ?? // Vercel (per-deployment)
    undefined

  if (url) return { url }
  if (env.WORKERS_CI) return { url: undefined, warning: NO_SITE_URL_ON_WORKERS }

  // Everywhere else, an unset address is a local build or a preview.
  return { url: undefined }
}
