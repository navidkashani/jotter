/**
 * Two jobs Astro cannot do for us.
 *
 * 1. **Serve vault attachments.** Notes reference images, PDFs and video that
 *    live beside them in the vault, not in `public/`. Optimizable rasters are
 *    rewritten to note-relative paths so Astro's image pipeline handles them;
 *    everything else (SVG, GIF, video, PDF) is served verbatim from `/_vault`,
 *    which this mounts in dev and copies into `dist/` at build.
 *
 * 2. **Report what the scan found.** Ambiguous links, alias collisions and slug
 *    collisions are real problems in a real vault, and a static site generator
 *    that swallows them is how a garden quietly rots. They print once, at the
 *    top of the build, naming files.
 */
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AstroIntegration } from 'astro'

import { VAULT_ASSET_BASE } from '../lib/href.js'
import { decodeSlug } from '../lib/url.js'
import { toNetlify, toVercel, robotsTxt, type RedirectRule } from '../lib/redirects.js'
import { feedXml, FEED_PATH, type FeedOptions } from '../lib/feed.js'
import type { Vault } from '../lib/vault.js'
import type { Graph } from '../lib/graph.js'
import type { AllNotesRoute } from '../lib/tree.js'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
}

const isMarkdown = (name: string) => /\.mdx?$/i.test(name)

/** Every non-markdown file in the vault, as vault-relative paths. */
async function attachments(root: string, prefix = ''): Promise<string[]> {
  let entries
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...(await attachments(root, rel)))
    else if (entry.isFile() && !isMarkdown(entry.name)) found.push(rel)
  }
  return found
}

export interface VaultIntegrationOptions {
  vault: Vault
  graph: Graph
  /**
   * `from` -> where it goes and how firmly, already merged from aliases and
   * config. Built by `buildRedirectRules` in `astro.config.ts`, where the vault
   * and the config both exist, and written out below in both host formats. The
   * `permanent` flag is why this is not a plain string map: see `RedirectRule`.
   */
  redirects: Record<string, RedirectRule>
  /**
   * Folders whose slug a note already owns, so the folder has no index page.
   *
   * Computed in `astro.config.ts`, where both lists exist, and reported here
   * because this is the channel a person reading a build log sees. The
   * resolution itself lives in `src/pages/[...slug].astro`.
   */
  shadowedFolders?: readonly { folder: string; slug: string; note: string }[]
  /**
   * The all-notes listing's slug, and the vault note or folder that took
   * `notes` if one did.
   *
   * Reported for the same reason `shadowedFolders` is, and in the same place:
   * this used to be a `console.warn` inside a `getStaticPaths`, which is a
   * line in the middle of a page-build log on a hook Astro may not re-run.
   */
  allNotes?: AllNotesRoute
  noIndex: boolean
  /** Absolute site URL, when one is configured. */
  siteUrl?: string
  /**
   * Everything `feedXml` needs except the notes, which this already has.
   *
   * Present **only** when `features.rss` is on, and that is the whole design:
   * off means the option is absent and nothing is written: no `existsSync`,
   * no cleanup path, no stale `rss.xml` surviving a flag being turned back off
   * in a `dist/` that was not cleaned.
   */
  feed?: Omit<FeedOptions, 'notes'>
}

export function jotterVault({
  vault,
  graph,
  redirects,
  shadowedFolders = [],
  allNotes,
  noIndex,
  siteUrl,
  feed,
}: VaultIntegrationOptions): AstroIntegration {
  return {
    name: 'jotter:vault',
    hooks: {
      'astro:config:done': ({ logger }) => {
        const warnings = [...vault.warnings, ...graph.warnings]
        for (const warning of warnings) logger.warn(warning)

        /**
         * The one host that cannot honour `preserve`, `obsidian` or a
         * `permalink:` carrying a capital letter, said once and by name.
         *
         * Netlify 301s a mixed-case path to its lowercase form, with no opt-out,
         * so `/Company/About+us` lands on `/company/about+us`, which this
         * build does not serve. Cloudflare Pages, Vercel and GitHub Pages all
         * serve static assets case-sensitively, as written. Degrade loudly: a
         * site that silently lost half its URLs on deploy is the failure this
         * whole feature exists to prevent.
         */
        /**
         * A folder and a note claiming one URL. The note wins, which is the
         * right answer and a surprising one: the sidebar still shows the folder
         * with its note count, and following it lands on the note instead of a
         * listing. Said by name so it is a decision rather than a discovery.
         */
        for (const { folder, slug, note } of shadowedFolders) {
          logger.warn(
            `"/${slug}" is claimed by both the note "${note}" and the folder "${folder}". ` +
              `The note wins and the folder has no index page, though the navigation still ` +
              `lists it. Give one of them a different permalink to choose deliberately.`,
          )
        }

        /**
         * The listing moved off `/notes` because the vault wanted that URL.
         * Nothing is wrong here and nothing is lost: both pages are built, and
         * every link jotter emits already points at the new address. Said once
         * anyway, because `/notes` now means something else than it did.
         */
        if (allNotes?.claimedBy) {
          logger.info(
            `"/notes" is the vault's own "${allNotes.claimedBy}", so the all-notes listing ` +
              `is at "/${allNotes.slug}". Vault content keeps the address it earned.`,
          )
        }

        const mixedCase = vault.notes.filter((n) => n.published && /\p{Lu}/u.test(n.slug))
        if (mixedCase.length > 0) {
          logger.warn(
            `${mixedCase.length} slug(s) contain an uppercase letter, starting with ` +
              `"/${mixedCase[0].slug}". Netlify 301s mixed-case paths to lowercase and cannot ` +
              `be told not to; Cloudflare Pages, Vercel and GitHub Pages serve them as written.`,
          )
        }

        // Degrade loudly, never silently cap: past the tested scale, say so
        // rather than letting a slow build look like a hang.
        if (vault.notes.length > 1000) {
          logger.warn(
            `${vault.notes.length} notes. jotter is tested to 1,000 notes and a 60s cold ` +
              `build; past that, build times grow and the graph gets dense. Nothing is dropped.`,
          )
        }
        logger.info(
          `${vault.notes.filter((n) => n.published).length} notes published ` +
            `(${vault.notes.length} scanned)${warnings.length ? `, ${warnings.length} warning(s)` : ''}.`,
        )
      },

      'astro:server:setup': ({ server }) => {
        /**
         * Make `astro dev` agree with a static host about what a request means.
         *
         * Astro's dev router decodes an incoming pathname with `decodeURI`
         * (`core/util/pathname.js`), which by definition does **not** decode a
         * reserved character (`%26` stays `%26`), and then keys static paths
         * by the raw param (`core/render/route-cache.js`). So a link to
         * `/Wisdom+%26+Approaches/…` 404s in dev while working perfectly in
         * production, where the host percent-decodes before looking for the
         * file. Nothing in the built site is wrong; only dev disagrees, which
         * is the worst place for a disagreement to live.
         *
         * The rewrite is to the one form that router is stable under: decode
         * the pathname to the slug, then re-encode with `encodeURI`, which
         * escapes exactly what `decodeURI` will put back. `#` and `?` are the
         * two `encodeURI` leaves alone and must not: they would truncate the
         * path. Query and hash are carried through untouched.
         *
         * A no-op for any URL without an encoded reserved character in it, so a
         * `derive` site (and every Vite and HMR request) is untouched.
         *
         * First, ahead of the `/_vault` middleware below, which already relies
         * on this ordering: it sees the decoded form and reads the file it
         * names.
         */
        server.middlewares.use((req, _res, next) => {
          const url = req.url ?? ''
          const cut = url.search(/[?#]/)
          const path = cut === -1 ? url : url.slice(0, cut)
          const minimal = encodeURI(decodeSlug(path)).replace(/#/g, '%23').replace(/\?/g, '%3F')
          if (minimal !== path) req.url = minimal + (cut === -1 ? '' : url.slice(cut))
          next()
        })

        server.middlewares.use((req, res, next) => {
          const url = req.url ?? ''
          if (!url.startsWith(`${VAULT_ASSET_BASE}/`)) return next()

          const rel = decodeURIComponent(url.slice(VAULT_ASSET_BASE.length + 1).split('?')[0])
          // Never let a request climb out of the vault.
          if (rel.split('/').includes('..')) {
            res.statusCode = 403
            return res.end('Forbidden')
          }

          const file = join(vault.root, rel.split('/').join(sep))
          stat(file).then(
            (info) => {
              if (!info.isFile()) return next()
              res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
              res.setHeader('Content-Length', String(info.size))
              createReadStream(file).pipe(res)
            },
            () => next(),
          )
        })
      },

      'astro:build:done': async ({ dir, logger }) => {
        const out = fileURLToPath(dir)

        const files = await attachments(vault.root)
        if (files.length > 0) {
          const outRoot = join(out, VAULT_ASSET_BASE.slice(1))
          for (const file of files) {
            const to = join(outRoot, file.split('/').join(sep))
            await mkdir(join(to, '..'), { recursive: true })
            await cp(join(vault.root, file.split('/').join(sep)), to)
          }
          logger.info(`Copied ${files.length} vault attachment(s) to ${VAULT_ASSET_BASE}/.`)
        }

        /**
         * Both formats, always. Which host this lands on is not knowable at
         * build time, and an unused `_redirects` on Vercel (or `vercel.json`
         * on Netlify) costs a few hundred bytes and is ignored.
         */
        const count = Object.keys(redirects).length
        if (count > 0) {
          await writeFile(join(out, '_redirects'), toNetlify(redirects))
          await writeFile(join(out, 'vercel.json'), toVercel(redirects))
          logger.info(`Wrote ${count} redirect(s) to _redirects and vercel.json.`)
        }

        /**
         * Beside the redirects and `robots.txt`, because this is already where
         * build-time files derived from config plus vault are written. A
         * separate integration would duplicate that plumbing for one
         * `writeFile`; `jotterSearch` earned its own because it runs Pagefind.
         *
         * The whole vault goes in, not the published subset: filtering is
         * `feedXml`'s job, in one tested place, precisely because the feed's
         * note list is the only one in the build that is not the route list.
         */
        if (feed) {
          const xml = feedXml({ notes: vault.notes, ...feed })
          await writeFile(join(out, FEED_PATH.slice(1)), xml)
          const items = (xml.match(/<item>/g) ?? []).length
          logger.info(`Wrote ${items} item(s) to ${FEED_PATH}.`)
        }

        await writeFile(
          join(out, 'robots.txt'),
          robotsTxt(noIndex, siteUrl && !noIndex ? new URL('/sitemap-index.xml', siteUrl).href : undefined),
        )
        if (noIndex) logger.warn('noIndex is set: robots.txt disallows everything and no sitemap was emitted.')
      },
    },
  }
}
