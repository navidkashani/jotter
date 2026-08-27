/**
 * Search, built after the site is.
 *
 * `src/integrations/vault.ts` is the template, and this is the same three-hook
 * shape: index `dist/` once it is finished, serve the result in dev, and report
 * what would go wrong before it does.
 *
 * **Pagefind fetches, and that is the whole design.** It loads index chunks
 * over plain HTTP GETs as you type, which is what makes a 1,000-note vault
 * searchable without shipping one enormous file. jotter's build asserts that
 * nothing it ships reaches the network, so `scripts/verify-build.mjs` exempts
 * `dist/pagefind/**` *by path* — a named exemption rather than a loosened rule.
 * Everything jotter authors still fails on `fetch(`, which is what keeps the
 * hover-preview decision enforced.
 */
import { createReadStream } from 'node:fs'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AstroIntegration, AstroIntegrationLogger } from 'astro'

/** Where Pagefind writes, and the URL the browser asks for it under. */
export const SEARCH_BASE = '/pagefind'

/**
 * Enough to serve the bundle in dev. `.js` is the one that matters: a wrong
 * content type there and the dynamic `import()` fails rather than 404s, which
 * is a much less obvious thing to debug.
 */
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
}

/**
 * What `writeFiles` emits that jotter can never ask for, and deletes again.
 *
 * Pagefind ships its own `<pagefind-*>` web components and a prebuilt search
 * UI, and writes all of them beside the index whether or not anything
 * references them. jotter references none of it — `src/scripts/search.ts`
 * draws its own chrome in jotter's own tokens, the same reason
 * `local-graph.ts` hand-rolls pan and zoom rather than taking `d3-zoom`.
 *
 * Left alone that is **418 KB** of JavaScript and CSS in `dist/`, six times
 * the rest of the site's client code put together, that no page will ever
 * name. Nothing downloads it, so no byte budget would ever catch it; it is
 * simply deployed, forever, to be ignored. On a theme whose headline claim is
 * "almost no JavaScript" that is not a rounding error.
 *
 * Deleting output somebody else wrote deserves saying out loud, so the build
 * logs what went. A forker who wants `pagefind-ui` deletes this list.
 */
const UNUSED = /^pagefind-(?:component-ui|modular-ui|ui|highlight)\.(?:js|css)$/

export interface SearchIntegrationOptions {
  /** BCP-47, as configured. Narrowed to ISO 639-1 below. */
  locale: string
  /** Every slug this build will route, so a collision with `/pagefind` is named. */
  slugs: readonly string[]
}

/**
 * Node's own `import()`, out of Vite's reach.
 *
 * Two things are going on, and both are load-bearing.
 *
 * *Lazy*, because a top-level `import 'pagefind'` would make a missing install
 * a module-resolution stack trace thrown while **the Astro config loads** —
 * before any of jotter's code has run, and with nothing in it naming the fix.
 *
 * *Through `new Function`*, because this file is transformed by Vite as part
 * of loading that config, and Vite rewrites every `import()` it can see into a
 * request to its own module runner — including one whose specifier is a
 * variable, and `/* @vite-ignore *​/` does not opt out of the rewrite. That
 * runner is **already closed** by the time `astro:build:done` fires, so the
 * rewritten import fails with `Vite module runner has been closed` and gets
 * reported as a missing package. A function body compiled at runtime is opaque
 * to any bundler, so this is plain Node resolution.
 */
const nodeImport = new Function('id', 'return import(id)') as (id: string) => Promise<unknown>

async function loadPagefind(logger: AstroIntegrationLogger) {
  try {
    return (await nodeImport('pagefind')) as typeof import('pagefind')
  } catch (error) {
    /**
     * The message names the likely cause but prints the real one underneath,
     * because "not installed" is only the *commonest* reason this throws. A
     * corrupt install, a permission error, or — the one that actually happens
     * on other people's machines — a missing platform binary after
     * `npm ci --omit=optional` all land here, and a confident wrong diagnosis
     * with the true error swallowed is worse than no diagnosis at all.
     */
    logger.error(
      'features.search is on, but `pagefind` could not be loaded.\n' +
        `  ${error instanceof Error ? error.message : String(error)}\n` +
        '  Usually this means it is not installed: run `npm install pagefind`, or set\n' +
        '  `features: { search: false }` in jotter.config.ts.',
    )
    /**
     * `process.exit` rather than `throw`, so the message above is the last
     * thing on screen. A thrown error here is reformatted with a stack trace
     * through jotter's own internals, which is noise around a one-line fix.
     */
    process.exit(1)
  }
}

export function jotterSearch({ locale, slugs }: SearchIntegrationOptions): AstroIntegration {
  /** Captured in `astro:config:done`, read by the dev middleware. */
  let outDir = ''

  return {
    name: 'jotter:search',
    hooks: {
      'astro:config:done': ({ config, logger }) => {
        outDir = fileURLToPath(config.outDir)

        /**
         * `astro.config.ts` reserves `notes`, `tags` and `404` against
         * redirects, but nothing reserves this: the index is written to
         * `dist/pagefind/`, so a note or folder slugged `pagefind` has its page
         * overwritten by a directory of index chunks and simply vanishes.
         *
         * A warning rather than a failure, and named, because `jotter:vault`
         * already reports slug collisions here and this is one more of the
         * same. Silence is the only wrong answer.
         */
        const collisions = slugs.filter((slug) => slug === 'pagefind' || slug.startsWith('pagefind/'))
        for (const slug of collisions) {
          logger.warn(
            `“${slug}” collides with the search index at ${SEARCH_BASE}/, which will overwrite its ` +
              `page. Rename the note or folder, or turn features.search off.`,
          )
        }
      },

      /**
       * Serve a previous build's index, the same middleware shape as the
       * `/_vault` handler in `vault.ts`. Search therefore works in `astro dev`
       * after one build; before any build the requests 404 and the modal says
       * so rather than throwing.
       */
      'astro:server:setup': ({ server }) => {
        server.middlewares.use((req, res, next) => {
          const url = req.url ?? ''
          if (!url.startsWith(`${SEARCH_BASE}/`)) return next()

          const rel = decodeURIComponent(url.slice(SEARCH_BASE.length + 1).split('?')[0])
          const indexDir = join(outDir, SEARCH_BASE.slice(1))
          const file = join(indexDir, rel.split('/').join(sep))

          /**
           * Never let a request climb out of the index directory — checked on
           * the *resolved* path rather than on the segments of the URL.
           *
           * Splitting on `/` and looking for `..` is the obvious guard and it
           * is separator-dependent: on Windows `%5C` decodes to a backslash,
           * which `join` treats as a separator and that test does not see, so
           * `/pagefind/..%5C..%5Cfoo` walks straight out. Comparing the joined
           * path against the directory it must stay under has no such blind
           * spot on any platform.
           */
          if (file !== indexDir && !file.startsWith(indexDir + sep)) {
            res.statusCode = 403
            return res.end('Forbidden')
          }
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
        const pagefind = await loadPagefind(logger)

        const { errors, index } = await pagefind.createIndex({
          /**
           * Pagefind wants ISO 639-1 and `locale` may carry a region (`en-GB`).
           * Forcing one language is right for a single-locale theme, and it
           * stops one stray foreign-language note splitting the index in two —
           * where half the vault would silently stop being searchable.
           */
          forceLanguage: locale.split('-')[0],
          /**
           * Pinned, not left to its default. The playground is an HTML page
           * under `/pagefind/playground/`, and `verify-build.mjs` walks *every*
           * `.html` in `dist/` — that page has no skip link, no `<main>`, no
           * `lang` and no `<title>`, so it would fail four assertions at once.
           */
          writePlayground: false,
        })

        if (!index) {
          logger.error(`Could not start Pagefind: ${errors.join('; ')}`)
          process.exit(1)
        }

        /**
         * The whole of `dist/`, filtered by `data-pagefind-body`. That
         * attribute is site-wide sticky — once it appears on any page, every
         * page without it is dropped — so pointing this at the output root
         * indexes the notes and nothing else. See `Note.astro`.
         *
         * `dist/pagefind/` does not exist yet at this point, so there is
         * nothing here for the index to eat its own tail on.
         */
        const indexDir = join(out, SEARCH_BASE.slice(1))
        const added = await index.addDirectory({ path: out })
        const written = await index.writeFiles({ outputPath: indexDir })
        await pagefind.close()

        for (const error of [...added.errors, ...written.errors]) logger.warn(error)

        /**
         * Read once, and everything below works from this list rather than
         * from the directory.
         *
         * A build was seen — once, and never reproduced in eleven attempts —
         * where this directory was read back mid-write: three CSS files were
         * missing, so the prune reported 346 KB instead of 408 and quietly left
         * the rest behind, and the entry file read below came back empty and
         * threw `Unexpected end of JSON input` as a stack trace. Whatever
         * caused that, two things were wrong with the code: a *partial* prune
         * looked exactly like a complete one, and an informational log line
         * could take down a build that had otherwise succeeded.
         *
         * So the listing is taken once, the prune reports how many of the files
         * it expected it actually removed, and a short read is a written error
         * rather than a trace. Nothing here retries: if the index really is
         * half-written the build must fail, because a half-written index ships
         * a search box that finds nothing.
         */
        /**
         * **Recursive**, and that is the point rather than a detail.
         *
         * The runtime and the entry file sit at the top level, but the index
         * *data* — every `.pf_fragment` and `.pf_index`, which is most of the
         * files and all of the content — lives one directory down. A
         * top-level-only listing would leave the emptiness check below covering
         * six files out of sixteen, and a half-written index of exactly the kind
         * it exists to catch would sail through it.
         *
         * `recursive` makes `entry.name` a basename, so the full path has to
         * come from `parentPath`; joining against `indexDir` would silently
         * look for `pagefind/en_abc.pf_fragment` and find nothing.
         */
        const wrote = await readdir(indexDir, { withFileTypes: true, recursive: true })

        const sizes = new Map<string, number>()
        for (const entry of wrote) {
          if (!entry.isFile()) continue
          const file = join(entry.parentPath, entry.name)
          sizes.set(file, (await stat(file)).size)
        }

        /**
         * Nothing Pagefind just wrote may be empty.
         *
         * This is the check that would have caught the corruption above on its
         * own: `pagefind.js` came out 0 bytes alongside the entry file, and an
         * index whose *runtime* is empty fails at `import()` in the reader's
         * browser — a failure that reaches production and looks like "search is
         * broken on your site" rather than like a bad build.
         */
        const empty = [...sizes].filter(([, size]) => size === 0).map(([file]) => relative(indexDir, file))
        if (empty.length > 0) {
          logger.error(
            `Pagefind wrote ${empty.length} empty file(s) to ${SEARCH_BASE}/: ${empty.join(', ')}.\n` +
              `  The index is incomplete, so search would load but find nothing. Re-run the build,\n` +
              `  and check that no other process is writing to dist/ at the same time.`,
          )
          process.exit(1)
        }

        /**
         * The entry file is the manifest the browser reads first, so it is also
         * the authority on what the rest of the directory is *for*: which
         * languages exist, which WebAssembly module each one loads, and how
         * many pages each holds. Read before pruning, so the prune below is
         * driven by it rather than by a second list that could drift from it.
         */
        let languages: Record<string, { page_count: number; wasm?: string }>
        try {
          languages = JSON.parse(await readFile(join(indexDir, 'pagefind-entry.json'), 'utf8')).languages
        } catch (error) {
          logger.error(
            `Pagefind wrote ${SEARCH_BASE}/ but its entry file is missing or unreadable, so the ` +
              `index is incomplete and search would find nothing.\n` +
              `  ${error instanceof Error ? error.message : String(error)}\n` +
              `  Re-run the build. If it happens again, check that nothing else is writing to ` +
              `dist/ at the same time.`,
          )
          process.exit(1)
        }

        /**
         * Every WebAssembly module the entry file does not name.
         *
         * Pagefind writes one per language it might need plus `unknown` as a
         * fallback — 68 KB of the 234 KB index here, for a language the browser
         * will never ask for, because `forceLanguage` above means the manifest
         * names exactly one. Same dead weight as the UI bundles, and the same
         * argument for removing it.
         *
         * Derived from the manifest rather than hardcoded to `unknown`, so
         * dropping `forceLanguage` or adding a locale keeps every wasm that is
         * actually reachable. If the manifest ever names one that was not
         * written, the emptiness check above has already failed the build.
         */
        const needed = new Set(Object.values(languages).map((language) => `wasm.${language.wasm}.pagefind`))
        const unreachable = (name: string) => /^wasm\..+\.pagefind$/.test(name) && !needed.has(name)

        let pruned = 0
        let removed = 0
        for (const [file, size] of sizes) {
          // Top-level only by construction: Pagefind's own bundles and its wasm
          // sit beside the entry file, and none of them is nested.
          const name = relative(indexDir, file)
          if (!UNUSED.test(name) && !unreachable(name)) continue
          pruned += size
          await rm(file)
          removed++
        }
        if (removed > 0) {
          logger.info(
            `Removed ${removed} Pagefind file(s) jotter never loads, ${Math.round(pruned / 1024)} KB.`,
          )
        }

        /**
         * Counted the way `jotter:vault` counts, so a build says how much of
         * the garden is actually searchable rather than only that it ran.
         *
         * And counted from the *entry file*, not from `page_count` on the
         * response above — that one is how many HTML files were read, which on
         * this demo is 22 against 9 genuinely indexed. Reporting the larger
         * number would have quietly claimed the tag pages and the 404 were
         * searchable when `data-pagefind-body` had already dropped them.
         */
        const searchable = Object.values(languages).reduce((total, l) => total + l.page_count, 0)

        logger.info(
          `${searchable} note(s) searchable (${added.page_count} page(s) scanned), indexed to ${SEARCH_BASE}/.`,
        )
      },
    },
  }
}
