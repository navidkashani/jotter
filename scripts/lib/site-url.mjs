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
 * `{ url, warning }`: the URL to write into the generated config, and anything
 * the person reading the build log should be told about how it was found.
 */
export function resolveSiteUrl(env = process.env) {
  const url =
    // Set this yourself to override everything, e.g. for a custom domain.
    absolute(env.OP_SITE_URL) ??
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
