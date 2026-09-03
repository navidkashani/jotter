/**
 * The verification toolkit: the reporting vocabulary, the readers over `dist/`,
 * and every assertion that more than one suite needs to run.
 *
 * There are two suites, and the split is the point of this module existing.
 *
 *   scripts/verify-build.mjs   over a finished `dist/`, and nothing else. It
 *                              runs inside `npm run build`, on every user's
 *                              site, so every check in it has to be one whose
 *                              failure is jotter's fault.
 *   scripts/verify-theme.mjs   rebuilds this repository under configurations
 *                              nobody ships (features off, analytics on, a
 *                              1,000-note vault) and asserts against fixtures
 *                              that exist in the demo garden and nowhere else.
 *                              Maintenance. It never runs on a user's site.
 *
 * They used to be one 3,900-line script behind a `--full` flag, and the cost of
 * that is written into its own docstring: a real user hit eight failures, five
 * of them anti-vacuity guards about fixtures only this repository has, and
 * removed the build gate from their build command. Their site is live and
 * unverified. A gate a user is right to delete is worse than no gate, and the
 * durable fix is that the checks they cannot pass are not in the script they
 * run.
 *
 * ## Three kinds of claim, and only one of them stops a deploy
 *
 *   check()    an **invariant**. Something jotter guarantees about every site
 *              it builds: a dead link is inert, a page has a `<main>`, the
 *              canonical spells the URL the links do. A failure is a defect in
 *              this theme, and the build stops.
 *
 *   observe()  an **observation**. Something true of the built site that the
 *              author decided: how many origins their notes embed from,
 *              whether every image they wrote carries dimensions. Reported,
 *              named, and then the build carries on.
 *
 *   demo()     a **demo-integrity guard**. "The demo still exercises this, so
 *              the assertion beside it is not passing on an empty set." A claim
 *              about *this repository*, and it runs only when this repository's
 *              own demo garden is what was built.
 *
 * Every check added anywhere should be able to answer: *whose fault is it when
 * this fails, and should that person's site stop shipping over it?*
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { join, relative, sep } from 'node:path'
import { spawn } from 'node:child_process'

export const ROOT = join(import.meta.dirname, '..', '..')
export const DIST = join(ROOT, 'dist')

/**
 * Is the build being verified this repository's own demo garden?
 *
 * `JOTTER_DEMO` already meant this, one step narrower.
 * `src/pages/library/[...slug].astro` returns no paths without it, so the
 * component gallery is a page in CI and absent from a reader's site. The
 * variable was never "build one more page". It was "this build is jotter
 * showing itself off", and an extra route is what that implied for routing.
 * The demo-integrity guards below are what it implies for verification.
 *
 * Read exactly the way that page reads it, bare truthiness so `JOTTER_DEMO=`
 * is off, because the two must never disagree about whether the demo's own
 * pages are in `dist/`.
 */
export const DEMO = Boolean(process.env.JOTTER_DEMO)

export let failures = 0
export let observations = 0
export let skipped = 0

export const pass = (label, detail = '') => console.log(`  ok    ${label}${detail ? `  ${detail}` : ''}`)
export const fail = (label, detail = '') => {
  failures++
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
}
export const note = (label, detail = '') => {
  observations++
  console.log(`  note  ${label}${detail ? `\n        ${detail}` : ''}`)
}
export const skip = (label) => {
  skipped++
  console.log(`  skip  ${label}`)
}

/** An invariant jotter guarantees. A failure is jotter's, and stops the build. */
export const check = (ok, label, detail = '') => (ok ? pass(label) : fail(label, detail))

/**
 * An observation about the author's content. Reported and never fatal.
 *
 * `strictInDemo` is for the statements that are an author's business on their
 * site and jotter's own on the demo, because there the content *is* jotter's:
 * every image in the demo garden is one this repository put there, so "every
 * image declares its dimensions" is a promise here and a remark elsewhere.
 * That is what keeps a real regression failing CI while the same measurement,
 * over a vault full of GIFs and remote images, only reports.
 */
export const observe = (ok, label, detail = '', { strictInDemo = false } = {}) =>
  strictInDemo && DEMO ? check(ok, label, detail) : ok ? pass(label) : note(label, detail)

/**
 * A guard that this repository's demo still covers the case the assertions
 * beside it are about. Meaningless anywhere else: a vault with no SVG, no dead
 * links and no `kitchen-sink` page is an ordinary vault, and it must deploy.
 */
export const demo = (ok, label, detail = '') => (DEMO ? check(ok, label, detail) : skip(label))

export const section = (title) => console.log(`\n${title}`)

export async function walk(dir, filter, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, filter, out)
    else if (filter(entry.name)) out.push(full)
  }
  return out
}

/**
 * Every text output in `dist/`, not only the pages.
 *
 * `pages` is `.html` and nothing else, which was invisible for as long as HTML
 * was all jotter emitted that carried a note's *words*. The feed ends that: it
 * carries titles and excerpts, it is published to the world, and a publish-gate
 * check that reads only `pages` would not read one byte of it, while claiming
 * to cover "anywhere in dist/". The feed's note list is also the one list in
 * the build that is not the route list, so a mistake in it is exactly what
 * nothing else would catch.
 *
 * So the corpus widens once, here, rather than the gate gaining a second
 * feed-shaped clause: the sitemap, `_redirects`, `vercel.json` and whatever is
 * emitted next are covered by the same move. Binary output (images,
 * attachments, Pagefind's index fragments) is skipped because a UTF-8 read of
 * it would find nothing either way.
 */
export const TEXT_OUTPUT = /\.(?:html|xml|json|txt|css|js|map|webmanifest)$/i


/**
 * Everything in `dist/` the checks read, in one pass.
 *
 * A function rather than the top-level `await`s this used to be, because the
 * theme suite imports this module and rebuilds `dist/` repeatedly: reading it
 * at import time would give every section the *first* build's pages, silently.
 */
export async function readDist() {
  if (!(await stat(DIST).catch(() => null))) {
    console.error('No dist/. Run `astro build` first.')
    process.exit(1)
  }

  const htmlFiles = await walk(DIST, (n) => n.endsWith('.html'))
  const pages = await Promise.all(
    htmlFiles.map(async (file) => ({ file: relative(DIST, file), html: await readFile(file, 'utf8') })),
  )
  const textFiles = await walk(DIST, (n) => TEXT_OUTPUT.test(n) || n === '_redirects')
  const outputs = await Promise.all(
    textFiles.map(async (file) => ({ file: relative(DIST, file), text: await readFile(file, 'utf8') })),
  )

  return { htmlFiles, pages, textFiles, outputs, authored: authoredOf(pages) }
}


/**
 * The URL a built page is served at. `dist/index.html` is `/`, not `/index`,
 * and `dist/notes.html` is `/notes`: `trailingSlash: 'never'`, which is also
 * how every href in the build spells them.
 *
 * Both output shapes are handled. `build.format: 'file'` is what
 * `astro.config.ts` sets and what every path below is written for, but the
 * `directory` form (`dist/notes/index.html`) still reduces correctly, so a
 * `dist/` left over from an older build reads rather than misreporting.
 */
export const routeOf = (file) =>
  '/' +
  relative(DIST, file)
    .split(sep)
    .join('/')
    .replace(/\/?index\.html$/, '')
    .replace(/\.html$/, '')

/**
 * The inverse: the file in `dist/` that serves a slug.
 *
 * `build.format: 'file'` writes `dist/<slug>.html`, with the root the single
 * exception, because `/` has no slug to name a file after and Astro writes it
 * as `dist/index.html` under either format.
 */
export const pageFileFor = (slug) =>
  slug === 'index' || slug === ''
    ? join(DIST, 'index.html')
    : join(DIST, ...`${slug}.html`.split('/'))

/**
 * `src/lib/url.ts`, reimplemented in four lines.
 *
 * This script is plain Node and that module is TypeScript, so it cannot import
 * it, and it should not want to. The point of the assertions below is that the
 * four producers of a page's URL agree with an *independent* idea of how a slug
 * is spelled; comparing jotter's encoder against itself would pass on the day
 * it started emitting `-and-`. `test/lib.test.ts` is what keeps the real
 * function honest.
 *
 * `routeOf` above reads file names off disk, which is the **slug**. Everything
 * a page emits (hrefs, canonical, sitemap) is the **URL**. These two convert.
 */
export const encodePath = (slug) =>
  slug.split('/').map((s) => encodeURIComponent(s).replace(/%2B/g, '+')).join('/')

export const decodePath = (path) =>
  path
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        // A malformed escape is a broken URL, but the raw form is what should
        // be reported, and every lookup below misses it either way.
        return s
      }
    })
    .join('/')

/**
 * The pages jotter wrote.
 *
 * `src/integrations/vault.ts` copies every non-markdown file in the vault to
 * `dist/_vault/` with no extension allowlist, so an `.html` attachment a reader
 * dropped in their own vault is in `pages` and is *not* jotter's markup. Three
 * sections named this exemption separately and the rest quietly did not, which
 * is how "every page has a `<main>` landmark" came to be a check a saved web
 * page in somebody's vault could fail a deploy with.
 */
export const authoredOf = (pages) => pages.filter(({ file }) => !file.startsWith(`_vault${sep}`))

/**
 * Everything inside the rendered note body, where our markdown output lands,
 * and everything outside it.
 *
 * The split is the answer to "whose markup is this?", and several checks below
 * need it to say anything useful. A dangling `<a href="/gone">` in the nav is
 * jotter emitting a link to a page it did not build; the same tag inside the
 * prose is an author who typed a path that is not there. One is a defect in
 * this theme and one is a typo in a note, they look identical in `dist/`, and
 * only this tells them apart.
 */
export const NOTE_BODY = '<div class="note-body prose">'

export function proseParts(html) {
  const parts = []
  let from = 0
  for (;;) {
    const open = html.indexOf(NOTE_BODY, from)
    if (open === -1) return parts

    /**
     * To the matching close, counting depth, rather than to the first
     * `</div>`.
     *
     * The first `</div>` is the end of the note body only on a note with no
     * `<div>` of its own, and a callout is a `<div>`. The regex this replaces
     * stopped at the callout's close, which put every paragraph after it on
     * jotter's side of the line: a perfectly ordinary note that opens with a
     * callout and then embeds a GIF would have failed the build for it.
     */
    let depth = 1
    let i = open + NOTE_BODY.length
    const body = i
    while (depth > 0) {
      const nested = html.indexOf('<div', i)
      const close = html.indexOf('</div>', i)
      if (close === -1) {
        // Unbalanced markup. The rest of the page is the safer answer: this
        // decides what is *not* asserted against, so over-reaching here would
        // fail somebody's build rather than under-report on it.
        parts.push(html.slice(body))
        return parts
      }
      if (nested !== -1 && nested < close) {
        depth++
        i = nested + '<div'.length
        continue
      }
      depth--
      i = close + '</div>'.length
      if (depth === 0) {
        /**
         * `<PrevNext>` renders inside the body div and is not markdown output,
         * so the region ends where it begins. That boundary was the whole of
         * the previous rule and is kept: those links are jotter's, and a
         * dangling one is jotter's to answer for.
         */
        const region = html.slice(body, close)
        const nav = region.indexOf('<nav class="prev-next"')
        parts.push(nav === -1 ? region : region.slice(0, nav))
      }
    }
    from = i
  }
}

export const proseOf = (html) => proseParts(html).join('\n')

/** The page minus the note body: nav, breadcrumb, rail, listings, `<head>`. */
export const chromeOf = (html) =>
  proseParts(html).reduce((rest, part) => (part ? rest.replace(part, '') : rest), html)

/**
 * Offenders in a set of pages, kept apart by which half of the page they were
 * found in. `find` is given one region and returns what is wrong with it.
 */
export function byRegion(pages, find) {
  const chrome = []
  const prose = []
  for (const { file, html } of pages) {
    for (const hit of find(chromeOf(html))) chrome.push(`${file}: ${hit}`)
    for (const hit of find(proseOf(html))) prose.push(`${file}: ${hit}`)
  }
  return { chrome, prose }
}

/* ------------------------------------------------------------------ links */

/**
 * Every internal `<a href>` points at something `dist/` actually serves.
 *
 * The section below this one was four assertions about link *markup* (empty
 * hrefs, dead links rendered as anchors, hrefs left on spans), and not one
 * about link *destination*. A build in which every internal link 404s passed
 * `npm run verify` cleanly, which is the hole `config.homepage` breaking every
 * link to the promoted note lived in for as long as it did.
 *
 * This is the general net rather than a homepage-shaped one: it equally catches
 * a renamed note whose backlinks were not rebuilt, a folder index that stopped
 * being emitted, and a redirect target that moved.
 *
 * Three kinds of target count as resolving, because all three are things a
 * reader following the link would actually get: a built page, a real file in
 * `dist/` (`/_vault/x.pdf`, `/rss.xml`, `/pagefind/*`), and a redirect source
 * in `_redirects`: a redirect is a working link whatever its status, and a
 * note's vacated URL is exactly that.
 *
 * Written as a function, like `thirdPartyOrigins()` below and for the same
 * reason: the theme suite re-runs it against a build with `homepage:` set, which is
 * the config mode that had nothing checking it.
 */
export async function internalLinks(pages) {
  const served = new Set([
    ...(await walk(DIST, (n) => n.endsWith('.html'))).map(routeOf),
    ...(await walk(DIST, () => true)).map((f) => '/' + relative(DIST, f).split(sep).join('/')),
  ])

  /**
   * Redirect sources are written in URL space and `served` is keyed in slug
   * space, so they are decoded on the way in: the same conversion the `href`
   * lookup below already does. Without it every non-ASCII redirect looked
   * dangling to this check while working perfectly in production.
   */
  const netlify = await readFile(join(DIST, '_redirects'), 'utf8').catch(() => '')
  for (const line of netlify.split('\n')) {
    const from = line.trim().split(/\s+/)[0]
    if (from.startsWith('/')) served.add(decodePath(from))
  }

  const authored = authoredOf(pages)

  let checked = 0
  const offenders = byRegion(authored, (region) => {
    const dangling = []
    for (const [, href] of region.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)) {
      // Site-absolute only. `//host/x` is another origin, `#x` is this page,
      // and a scheme is somebody else's problem.
      if (!href.startsWith('/') || href.startsWith('//')) continue
      const path = decodePath(href.split('#')[0].split('?')[0])
      const target = path.length > 1 ? path.replace(/\/$/, '') : path
      checked++
      if (!served.has(target)) dangling.push(href)
    }
    return dangling
  })

  check(
    offenders.chrome.length === 0,
    'every internal link jotter emits points at a page, a file or a redirect',
    offenders.chrome.slice(0, 12).join('\n        '),
  )
  /**
   * The same sweep over the note body, reported rather than asserted. A
   * hand-written `[see](/notes/moved)` pointing at a page that is not there is
   * a typo in a note. It is the author's to fix, and not a reason their whole
   * site cannot deploy. jotter's own guarantee is narrower and is kept
   * elsewhere: a `[[wikilink]]` that resolves to nothing renders as an inert
   * span, which is the check three lines above this function's call.
   */
  observe(
    offenders.prose.length === 0,
    'every internal link a note writes points at a page, a file or a redirect',
    offenders.prose.slice(0, 12).join('\n        '),
    { strictInDemo: true },
  )
  // Without this the check above passes loudest on a `dist/` with no links in
  // it at all.
  demo(checked > 0, 'the demo actually has internal links to resolve')
}

/**
 * The four things that emit a page's URL spell it identically.
 *
 * `internalLinks()` above compares after decoding, so it passes on a site whose
 * links and canonical disagree, which is the duplicate-URL split Google's URL
 * guidelines warn about, and RFC 3986 §6.2.2.2 is the reason it is a real
 * split: `/a&b` and `/a%26b` are formally different URLs, and percent-encoded
 * reserved characters are protected from normalisation. So "the link resolves"
 * and "the link is the same URL the page calls itself" are two claims, and only
 * the first was ever checked. This is the second.
 *
 * The four producers are the `<a href>`, the canonical link and `og:url`, the
 * sitemap entry, and the Pagefind result. Each is compared against the spelling
 * `encodePath` derives from the page's own path in `dist/`: an independent
 * answer rather than jotter's, for the reason given at that function.
 *
 * Whichever of them this build has: canonical and the sitemap need `config.url`
 * and Pagefind needs `features.search`, so on a config with neither this checks
 * the hrefs alone and says how much it covered. The theme suite sets both.
 */
export async function producersAgree(pages) {
  const authored = authoredOf(pages)

  /** The URL each page ought to be spelled as, keyed by its route on disk. */
  const expected = new Map(
    authored.map(({ file }) => {
      const route = routeOf(join(DIST, file))
      return [route, route === '/' ? '/' : encodePath(route)]
    }),
  )

  const offenders = []
  /**
   * An `<a href>` inside the note body is the one producer here the author
   * writes by hand, and `/Wisdom & Approaches/Integrity` typed literally into a
   * note is a link that works and a spelling that differs. It is collected
   * apart and reported rather than asserted; the other three are jotter's.
   */
  const proseOffenders = []
  const counted = { href: 0, canonical: 0, ogUrl: 0, sitemap: 0, search: 0 }

  /**
   * `mustBeAPage` is what turns "I could not find that route" from a skip into
   * a failure, and it exists because the skip hid a live defect.
   *
   * For an `<a href>`, a route this build did not emit is not this check's
   * business: `internalLinks` owns dead links, and a note may link anywhere.
   * For a canonical or an `og:url` it is the *whole* business. Those name the
   * page they are on, jotter writes them, and one naming a route that is not a
   * page cannot be compared against anything, so it silently counted as fine.
   *
   * That is exactly how `build.format: 'file'` shipped a canonical of
   * `/welcome.html` on a site whose every link says `/welcome`: the lookup
   * missed, the comparison never ran, and four green producers were three.
   */
  const compare = (kind, route, spelling, where, { mine = true, mustBeAPage = false } = {}) => {
    const want = expected.get(route)
    if (want === undefined) {
      if (!mustBeAPage) return
      offenders.push(`${kind} ${where}: ${spelling} names no page this build emitted`)
      return
    }
    counted[kind]++
    if (spelling !== want) (mine ? offenders : proseOffenders).push(`${kind} ${where}: ${spelling} != ${want}`)
  }

  /** The path part of a URL that may be absolute or site-relative. */
  const pathOf = (url) => (url.startsWith('/') ? url : new URL(url).pathname)

  for (const { file, html } of authored) {
    // Walked as two regions rather than filtered afterwards: the same href can
    // legitimately appear in the nav and in a note, and asking which one a
    // misspelling came from has to be answered by where it was found.
    for (const [region, jotters] of [
      [chromeOf(html), true],
      [proseOf(html), false],
    ]) {
      for (const [, href] of region.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)) {
        if (!href.startsWith('/') || href.startsWith('//')) continue
        const path = href.split('#')[0].split('?')[0]
        const route = decodePath(path.length > 1 ? path.replace(/\/$/, '') : path)
        compare('href', route, path, file, { mine: jotters })
      }
    }

    const canonical = /<link rel="canonical" href="([^"]*)"/.exec(html)
    if (canonical) {
      const path = pathOf(canonical[1])
      compare('canonical', decodePath(path), path, file, { mustBeAPage: true })
    }

    const ogUrl = /<meta property="og:url" content="([^"]*)"/.exec(html)
    if (ogUrl) {
      const path = pathOf(ogUrl[1])
      compare('ogUrl', decodePath(path), path, file, { mustBeAPage: true })
    }
  }

  for (const sitemapFile of await walk(DIST, (n) => /^sitemap.*\.xml$/.test(n))) {
    const xml = await readFile(sitemapFile, 'utf8')
    for (const [, loc] of xml.matchAll(/<loc>([^<]*)<\/loc>/g)) {
      // The sitemap index lists the sitemaps, not the pages.
      if (/sitemap.*\.xml$/.test(loc)) continue
      const path = pathOf(loc.replace(/&amp;/g, '&'))
      // Same rule as the canonical: a sitemap entry jotter wrote for a URL it
      // did not build is an entry a crawler will follow to a 404.
      compare('sitemap', decodePath(path), path, relative(DIST, sitemapFile), { mustBeAPage: true })
    }
  }

  /**
   * Pagefind's fragments are gzip after a `pagefind_dcd` marker, and the `url`
   * in each is the **file path** it indexed, not the address: under
   * `build.format: 'file'` that is `/atomic-notes.html`, and under the
   * `directory` format it was `/atomic-notes/`. So the moves
   * `normalizeResultUrl()` makes at runtime are made here too, and the result
   * is what a reader clicking a search result actually gets.
   *
   * Written out rather than imported, like `encodePath` above it and for the
   * same reason: this has to be an *independent* statement of what a stored
   * result must reduce to, or it would agree with the runtime on the day the
   * runtime started getting it wrong.
   */
  for (const fragment of await walk(DIST, (n) => n.endsWith('.pf_fragment'))) {
    const raw = await readFile(fragment)
    const start = raw.indexOf(0x1f, 0)
    let json
    try {
      json = gunzipSync(raw.subarray(start)).toString('utf8')
    } catch {
      continue // Not a shape this check understands; the search section owns it.
    }
    const url = /"url":"([^"]*)"/.exec(json)
    if (!url) continue
    const trimmed = url[1]
      .replace(/\/+$/, '')
      .replace(/\.html$/i, '')
      .replace(/^\/index$/i, '')
    const spelling = encodePath(decodePath(trimmed)) || '/'
    compare('search', decodePath(trimmed) || '/', spelling, relative(DIST, fragment), {
      mustBeAPage: true,
    })
  }

  check(
    offenders.length === 0,
    'every producer of a page’s URL spells it identically',
    offenders.slice(0, 12).join('\n        '),
  )
  observe(
    proseOffenders.length === 0,
    'every link a note writes spells its target the way the page spells itself',
    proseOffenders.slice(0, 12).join('\n        '),
    { strictInDemo: true },
  )
  const covered = Object.entries(counted).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`)
  // Without this the check above passes loudest on a build that emitted none of
  // them, and three of the four are behind a config key.
  demo(counted.href > 0, 'the demo actually has URLs to compare', covered.join(', '))

  /**
   * Which producers this config actually has, said out loud rather than left to
   * be inferred from a number: the same shape as `no feed in dist/` below.
   * Canonical, `og:url` and the sitemap need `url`; search needs
   * `features.search`. `npm run verify:full` sets both and covers all four.
   */
  const absent = [
    counted.canonical === 0 && 'canonical',
    counted.ogUrl === 0 && 'og:url',
    counted.sitemap === 0 && 'sitemap',
    counted.search === 0 && 'search',
  ].filter(Boolean)
  if (absent.length > 0) {
    pass(`${absent.join(', ')} not in this build`, 'needs `url`, or `features.search`')
  }
}

/* ------------------------------------------------------------- direction */

/**
 * Elements that never have a closing tag, and so never open a scope.
 * Without these the stack below would swallow every sibling of an `<img>`.
 */
export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
])

/** Elements whose content is text, not markup. A `<` in here is not a tag. */
export const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])

/**
 * Every `dir` attribute in a page, each with the direction its element would
 * have inherited had it not set one.
 *
 * A stack rather than a regex sweep, because the claim being checked is about
 * *inheritance*: `dir="rtl"` on a paragraph inside an already-`rtl` blockquote
 * is the redundant attribute this is looking for, and nothing that reads one
 * tag at a time can see it. Astro emits well-formed markup, so a tag scanner
 * with a stack is exact here in a way it would not be over hand-written HTML.
 */
export function directionAttributes(html) {
  const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  const found = []
  const stack = []
  let rawUntil = null
  let match

  while ((match = TAG.exec(html)) !== null) {
    const [, closing, rawName, attrs, selfClosing] = match
    const tag = rawName.toLowerCase()

    if (rawUntil) {
      if (closing && tag === rawUntil) rawUntil = null
      continue
    }
    if (closing) {
      const opened = stack.findLastIndex((entry) => entry.tag === tag)
      if (opened !== -1) stack.length = opened
      continue
    }

    const inherited = stack.length > 0 ? stack[stack.length - 1].dir : undefined
    const dir = /\bdir="([^"]*)"/.exec(attrs)?.[1]
    if (dir !== undefined) found.push({ tag, dir, inherited, end: TAG.lastIndex })

    if (RAW_TEXT.has(tag) && !selfClosing) rawUntil = tag
    else if (!VOID_TAGS.has(tag) && !selfClosing) stack.push({ tag, dir: dir ?? inherited })
  }

  return found
}

/** The text of the element that opened at `end`, tags and entities stripped. */
export const elementText = (html, end, tag) => {
  const close = html.indexOf(`</${tag}>`, end)
  return html.slice(end, close === -1 ? end + 400 : close).replace(/<[^>]*>/g, '')
}

/**
 * Every right-to-left script jotter claims to detect, as a second opinion.
 *
 * Deliberately *not* an import of `src/lib/bidi.ts`: this file is `.mjs` and
 * could not import it anyway, but the point stands on its own: a check that
 * restates the implementation proves only that the implementation is
 * self-consistent. These are Unicode block ranges rather than script
 * properties, written from the other end.
 */
export const RTL_CHARACTER =
  /[֐-׿؀-ۿ܀-ݏހ-޿߀-߿ࠀ-࠿ࡀ-࡟ࢠ-ࣿיִ-﷿ﹰ-﻿]|[\u{10D00}-\u{10D3F}\u{1E900}-\u{1E95F}]/u

export const LATIN_LETTER = /[A-Za-z]/

/**
 * Per-block text direction, over a real build.
 *
 * The unit tests own the rule; what only `dist/` can show is that the rule
 * reached the page, and, far more importantly, that it *stayed off* the
 * blocks that agree with it. Written as a function, like `internalLinks()`
 * above, because the theme suite runs the whole thing again against a rebuild with
 * `dir: 'rtl'`. That mirror pass is the only thing that can prove the feature
 * is symmetric, and it is what would have caught the two defects the plan's
 * scenario pass found by hand.
 */
export function directionSection(pages, outputs) {
  /**
   * The hole beside the `lang` check in `section('Markup')`, which has always
   * asserted that a page declares a language and never that it declares a
   * direction. Every per-block `dir` below is stated relative to this one, so
   * a page missing it has no baseline for anything else here to mean.
   */
  const undeclared = authoredOf(pages).filter(({ html }) => !/<html[^>]+\bdir="(?:ltr|rtl)"/.test(html))
  check(
    undeclared.length === 0,
    'every page declares ltr or rtl on <html>',
    undeclared.map((p) => p.file).join(', '),
  )

  /**
   * The invariant that keeps the `[dir='rtl']` idiom in `base.css` valid.
   * jotter computes direction at build time and emits the answer; a `dir="auto"`
   * in `dist/` means something has started deferring to the browser instead,
   * and `[dir='rtl']` does not match an element whose direction the browser
   * resolved. Over every text output rather than the pages, so a stray one in
   * the feed or a bundled script counts too.
   */
  const auto = outputs.filter(({ text }) => /\bdir="auto"/.test(text))
  observe(
    auto.length === 0,
    'no dir="auto" anywhere in dist/',
    auto.map((p) => p.file).join(', '),
    { strictInDemo: true },
  )

  const authored = authoredOf(pages)
  const attributes = authored.map(({ file, html }) => ({
    file,
    html,
    dirs: directionAttributes(html),
  }))

  const illegal = []
  const redundant = []
  const unfounded = []
  let marked = 0
  const markedTags = new Set()

  for (const { file, html, dirs } of attributes) {
    const page = dirs.find(({ tag }) => tag === 'html')?.dir
    for (const { tag, dir, inherited, end } of dirs) {
      if (dir !== 'ltr' && dir !== 'rtl') {
        illegal.push(`${file}: <${tag} dir="${dir}">`)
        continue
      }
      if (inherited !== undefined && dir === inherited) {
        redundant.push(`${file}: <${tag} dir="${dir}"> inside a ${inherited} parent`)
      }
      if (dir === 'rtl' && tag !== 'html' && !RTL_CHARACTER.test(elementText(html, end, tag))) {
        unfounded.push(`${file}: <${tag} dir="rtl"> over text with no RTL character in it`)
      }
      if (tag !== 'html' && dir !== page) {
        marked++
        markedTags.add(tag)
      }
    }
  }

  /**
   * The three below walk the note body as well as the chrome, and `dir` is an
   * attribute an author can write in raw HTML like any other. Where jotter is
   * the only author, which is the demo, they are enforced.
   */
  observe(illegal.length === 0, 'no dir with a value other than ltr or rtl', illegal.join('\n        '), {
    strictInDemo: true,
  })

  /**
   * The zero-cost claim, and the check that catches a future "simplification"
   * into marking every block the way Obsidian Publish does.
   *
   * Stated against each page's own `<html dir>` rather than against the
   * literal `ltr`, so it is equally right on the theme suite’s RTL rebuild, where
   * `dir="ltr"` on an English paragraph is the *correct* answer and marking
   * the Persian would be the bug.
   */
  observe(
    redundant.length === 0,
    'no block repeats the direction it already inherits',
    redundant.slice(0, 12).join('\n        '),
    { strictInDemo: true },
  )

  observe(
    unfounded.length === 0,
    'every rtl block actually contains right-to-left characters',
    unfounded.slice(0, 8).join('\n        '),
    { strictInDemo: true },
  )

  /**
   * And the demo actually exercises it, so the three checks above are not
   * passing over a build with no mixed-direction content in it at all. Stated
   * as "blocks that differ from the page" rather than "Persian blocks",
   * because on the RTL rebuild the blocks that differ are the English ones.
   */
  demo(
    marked > 0 && markedTags.size > 1,
    'the demo has blocks running the other way for these checks to bite on',
    `${marked} marked block(s) across ${markedTags.size} kind(s): ${[...markedTags].join(', ')}`,
  )
}

/* ------------------------------------------------------------ redirects */

/**
 * A function, and re-walking `dist/` rather than closing over `htmlFiles`, for
 * the same reason `internalLinks()` and `thirdPartyOrigins()` are: the theme suite
 * runs it again against the homepage build, which is the only one that emits a
 * redirect from a note's own vacated slug: precisely the kind that could
 * dangle or shadow.
 */
export async function redirectsAndRobots() {
  const netlify = await readFile(join(DIST, '_redirects'), 'utf8').catch(() => null)
  const vercel = await readFile(join(DIST, 'vercel.json'), 'utf8').catch(() => null)

  /**
   * Both formats or neither, which is what `src/integrations/vault.ts`
   * actually promises: which host this lands on is not knowable at build time,
   * so a site that redirects on Netlify and 404s on Vercel is the failure. A
   * vault where no note declares an `aliases:` or a `permalink:` has nothing to
   * redirect and correctly writes no file at all. Asserting the files exist
   * unconditionally made a vault with no aliases, which is most of them,
   * unable to deploy.
   */
  if (netlify === null && vercel === null) {
    pass('no redirects in dist/', 'no note declares an alias or a permalink')
  } else {
    check(netlify !== null, '_redirects was written', 'vercel.json was, so a Netlify deploy would 404')
    check(vercel !== null, 'vercel.json was written', '_redirects was, so a Vercel deploy would 404')
  }

  if (netlify && vercel) {
    const fromNetlify = netlify.trim().split('\n').filter(Boolean)
    const fromVercel = JSON.parse(vercel).redirects
    check(
      fromNetlify.length === fromVercel.length,
      'both redirect formats describe the same set',
      `${fromNetlify.length} vs ${fromVercel.length}`,
    )

    /**
     * Both comparisons decode first. `routeOf` reads file names off disk (slug
     * space), while a redirect's `source` and `destination` are URLs, so the
     * two only matched by accident of every slug so far being ASCII. Every
     * non-ASCII redirect this build has ever written reported as dangling, and
     * every one that really did shadow a page reported as fine.
     */
    const routes = new Set((await walk(DIST, (n) => n.endsWith('.html'))).map(routeOf))

    // A redirect pointing at a page that does not exist is worse than none.
    const dangling = fromVercel.filter(
      (r) => !routes.has(decodePath(r.destination)) && r.destination !== '/',
    )
    check(dangling.length === 0, 'every redirect points at a real page', dangling.map((r) => `${r.source} -> ${r.destination}`).join(', '))

    /**
     * And one that shadows a real page would make that page unreachable. Every
     * redirect jotter writes comes from an `aliases:` or a `permalink:` an
     * author typed, so an alias that collides with another note's slug is
     * content: reported, named, and the site still ships with one of the two
     * addresses working.
     */
    const shadowing = fromVercel.filter((r) => routes.has(decodePath(r.source)))
    observe(
      shadowing.length === 0,
      'no redirect shadows a real page',
      shadowing.map((r) => r.source).join(', '),
      { strictInDemo: true },
    )
  }

  const robots = await readFile(join(DIST, 'robots.txt'), 'utf8').catch(() => null)
  check(robots !== null, 'robots.txt was written')
}

/* -------------------------------------------------- third-party origins */

/**
 * The assertion the analytics feature owes.
 *
 * `analytics.provider` is the only switch in jotter that puts somebody else's
 * origin in the page, and until it existed there was nothing here to check: a
 * build contains **zero** absolute external URLs of any kind, so this starts
 * from a provably clean floor rather than from a guess.
 *
 * How it knows what to expect without reading `jotter.config.ts`: it doesn't
 * have to. `Analytics.astro` marks its own tag with `data-jotter-analytics`,
 * the same idiom as `data-search` and `data-preview`, and the marker names the
 * provider. So the built HTML says what jotter meant to emit, and anything
 * external *without* a marker got there some other way, which is exactly what
 * this is for. Parsing the config as text would be brittle in a way this is
 * not, and would break on a computed config besides.
 *
 * A fixed allowlist of the six vendor origins was the obvious alternative and
 * it is wrong: `host` exists precisely so a self-hosted Plausible, Umami or
 * GoatCounter can live on the reader's own domain, which no list can predict.
 * Hardcoding one would fail the build for the users jotter should most want.
 */
/**
 * Written as a function rather than inline, because the theme suite re-runs every one
 * of these against a second build with analytics forced on. On the committed
 * config the set of origins is empty and every check below is vacuously true,
 * so without that second pass, deleting this whole section would change
 * nothing, and an assertion that cannot fail is not an assertion.
 */
export function thirdPartyOrigins(pages) {
  const REMOTE = /^(?:https?:)?\/\//i
  const originOf = (url) => new URL(url.startsWith('//') ? `https:${url}` : url).origin

  const tagsOf = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => m[0])
  const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? ''
  const has = (tag, name) => new RegExp(`\\b${name}(?=[\\s>=])`).test(tag)

  const authored = authoredOf(pages)

  /**
   * Only the attributes that actually *fetch*. `<a href>` is deliberately not
   * here (a link to another site is not a request, and the demo garden is full
   * of them), and neither is `<link rel="canonical">` or `<meta og:url>`, which
   * carry `config.url` as a declaration rather than a subresource. That is why
   * the `<link>` sweep is gated on `rel` instead of on `href`.
   */
  const FETCHING_REL = /^(stylesheet|preload|modulepreload|preconnect|dns-prefetch|prefetch|prerender)$/
  const srcsetUrls = (value) =>
    value.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean)

  const subresources = (html) => {
    const urls = []
    for (const name of ['script', 'img', 'iframe', 'source']) {
      for (const tag of tagsOf(html, name)) {
        urls.push(attr(tag, 'src'), ...srcsetUrls(attr(tag, 'srcset')))
      }
    }
    for (const tag of tagsOf(html, 'link')) {
      if (FETCHING_REL.test(attr(tag, 'rel'))) urls.push(attr(tag, 'href'))
    }
    return urls.filter((url) => url && REMOTE.test(url))
  }

  /**
   * Split by who wrote the tag, because the two halves are different claims.
   *
   * jotter's own chrome must fetch from nowhere but the configured analytics
   * vendor. That is the promise the README makes, and nothing an author does
   * to a note can excuse breaking it. A note that embeds a picture from a CDN,
   * or an author who pasted a YouTube URL, is describing their own page: worth
   * saying out loud, never worth refusing to publish over. The first version of
   * this check made no distinction and failed a real deploy over a note with a
   * YouTube link and a Twitter link in it.
   */
  const external = authored.flatMap(({ file, html }) =>
    subresources(chromeOf(html)).map((url) => ({ file, url, origin: originOf(url) })),
  )
  const inNotes = authored.flatMap(({ file, html }) =>
    subresources(proseOf(html)).map((url) => ({ file, url, origin: originOf(url) })),
  )

  /** Every external `<script>` jotter's own markup carries, marked or not. */
  const externalScripts = authored.flatMap(({ file, html }) =>
    tagsOf(chromeOf(html), 'script')
      .filter((tag) => REMOTE.test(attr(tag, 'src')))
      .map((tag) => ({ file, tag, provider: attr(tag, 'data-jotter-analytics') })),
  )

  const unmarked = externalScripts.filter((s) => !s.provider)
  check(
    unmarked.length === 0,
    'every external script jotter emits is one it meant to',
    unmarked.map((s) => `${s.file}: ${attr(s.tag, 'src')}`).join(', '),
  )

  /**
   * Cardinality, which set membership alone would not give: two providers, or a
   * tracker riding along beside the configured one, both collapse to "an
   * external origin appeared" without this.
   */
  const origins = [...new Set(external.map((e) => e.origin))]
  check(
    origins.length <= 1,
    'jotter’s own markup talks to at most one origin that is not this site',
    origins.join(', '),
  )

  const noteOrigins = [...new Set(inNotes.map((e) => e.origin))]
  observe(
    noteOrigins.length === 0,
    'no note loads a file from another origin',
    noteOrigins.length
      ? `${noteOrigins.join(', ')}; a reader of those pages is seen by those hosts`
      : '',
    { strictInDemo: true },
  )

  /**
   * No `<iframe>` anywhere in `dist/` points at somebody else's origin.
   *
   * Nothing an author writes in *markdown* asks jotter for a cross-origin
   * frame: a remote document is a link card, and a remote video is a facade
   * whose player is built by `src/scripts/embed.ts` **after a click**. That is
   * exactly what the facade buys, and this states the price of losing it. An
   * `<iframe src="https://www.youtube.com/embed/…">` in the markup would put
   * Google's frame, its cookies and its scripts on the page of every reader who
   * never pressed play, which is precisely what pasting a URL must not do.
   *
   * Split the way `noteOrigins` above is split, and for the same reason. In
   * jotter's own chrome a cross-origin frame is this theme's defect and stops
   * the build. In a note it is an author who pasted raw HTML into their
   * markdown, which is a thing people do and their business to decide; on this
   * repository's demo, where every page is jotter's own, it fails.
   */
  const framesIn = (html) =>
    tagsOf(html, 'iframe').filter((tag) => REMOTE.test(attr(tag, 'src'))).map((tag) => attr(tag, 'src'))

  const framedChrome = authored.flatMap(({ file, html }) =>
    framesIn(chromeOf(html)).map((src) => `${file}: ${src}`),
  )
  const framedNotes = authored.flatMap(({ file, html }) =>
    framesIn(proseOf(html)).map((src) => `${file}: ${src}`),
  )
  check(
    framedChrome.length === 0,
    'no <iframe> jotter emits points at another origin',
    framedChrome.join('\n        '),
  )
  observe(
    framedNotes.length === 0,
    'no <iframe> in a note points at another origin: a player arrives on a click',
    framedNotes.join('\n        '),
    { strictInDemo: true },
  )
  // Without this the assertion above is loudest on a build that embeds nothing
  // at all, which is every build that could not possibly have failed it.
  const facades = authored.filter(({ html }) => html.includes('class="video-embed"'))
  demo(facades.length > 0, 'the demo actually has a click-to-play facade', 'no .video-embed anywhere')

  const providers = [...new Set(externalScripts.map((s) => s.provider))]

  if (providers.length === 0) {
    pass('no third-party origin in dist/', 'analytics.provider is none')
    /**
     * The markup half, and the reason it is asserted separately: `provider:
     * 'none'` must emit *nothing at all*: not an empty tag, not a disabled
     * one. This is the analytics counterpart of `search off writes no
     * dist/pagefind/`.
     */
    const stray = authored.filter(({ html }) => html.includes('data-jotter-analytics'))
    check(stray.length === 0, 'no analytics markup at all when no provider is set', stray.map((p) => p.file).join(', '))
  } else {
    check(providers.length === 1, 'one analytics provider, not several', providers.join(', '))

    const [provider] = providers
    /**
     * Which attribute carries the configured id, per provider. `includes` is
     * not used and `=== id` is not possible (the verifier never reads the id)
     * so what is asserted is that the attribute the vendor requires is present
     * and non-empty. A Plausible tag with no `data-domain` records nothing,
     * forever, silently; that is the failure this catches.
     */
    const identifier = {
      plausible: (tag) => attr(tag, 'data-domain'),
      umami: (tag) => attr(tag, 'data-website-id'),
      goatcounter: (tag) => attr(tag, 'data-goatcounter'),
      fathom: (tag) => attr(tag, 'data-site'),
      cloudflare: (tag) => attr(tag, 'data-cf-beacon'),
      google: (tag) => new URLSearchParams(attr(tag, 'src').split('?')[1] ?? '').get('id') ?? '',
    }[provider]

    check(identifier !== undefined, `data-jotter-analytics names a provider jotter has`, provider)

    /**
     * On *every* page, exactly once. Fewer means a page template that bypasses
     * `Base.astro`; more is a double-mount, which double-counts every hit.
     */
    const perPage = authored.map(({ file, html }) => ({
      file,
      n: tagsOf(html, 'script').filter((tag) => attr(tag, 'data-jotter-analytics')).length,
    }))
    const missing = perPage.filter((p) => p.n === 0)
    const doubled = perPage.filter((p) => p.n > 1)
    check(missing.length === 0, 'the analytics tag is on every page', missing.map((p) => p.file).join(', '))
    check(doubled.length === 0, 'the analytics tag is on each page only once', doubled.map((p) => p.file).join(', '))

    if (identifier) {
      const anonymous = externalScripts.filter((s) => !identifier(s.tag))
      check(
        anonymous.length === 0,
        'the configured id reaches the tag',
        anonymous.map((s) => s.file).join(', '),
      )
    }

    /**
     * A render-blocking third-party script is the one way this feature hurts a
     * reader who did not ask for it. All six documented snippets carry `defer`
     * or `async`; this stops a future edit from losing one.
     */
    const blocking = externalScripts.filter((s) => !has(s.tag, 'defer') && !has(s.tag, 'async'))
    check(blocking.length === 0, 'the analytics script never blocks paint', blocking.map((s) => s.file).join(', '))

    /**
     * Reported, not asserted, and it names the gap deliberately: the vendor's
     * script is not a file in `dist/`, so the 32 KB budget above cannot see it
     * and does not try to guess. A page loading gtag.js is not a 29 KB page in
     * any sense a reader experiences, and saying so beats a silent exclusion.
     */
    pass(
      'third-party scripts',
      `${provider} on ${perPage.filter((p) => p.n > 0).length}/${authored.length} page(s) from ${origins.join(', ')}; not counted against the JavaScript budget`,
    )
  }
}

/* -------------------------------------------------------------------- feed */

/**
 * A minimal XML well-formedness scan, hand-rolled.
 *
 * Node ships no XML parser and the feed takes no dependency to concatenate
 * forty lines of markup, so this is deliberately narrow: it is aimed at the two
 * ways a *generated* feed actually breaks: a tag that never closes, and an
 * interpolated value that reached the file unescaped. Both are the failure
 * Quartz's CDATA has by construction, and both are what `escapeXml` in
 * `src/lib/feed.ts` exists to prevent.
 *
 * `xmllint --noout` and the W3C Feed Validation Service are the real parsers,
 * and the README points at them. This is the one that runs on every build.
 *
 * Returns a reason, or `null` when nothing is wrong.
 */
export const ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/

export function xmlWellFormed(xml) {
  const bareAmpersand = (text) => {
    for (let k = 0; k < text.length; k++) {
      if (text[k] === '&' && !ENTITY.test(text.slice(k))) return true
    }
    return false
  }

  const stack = []
  let roots = 0
  let i = 0

  while (i < xml.length) {
    const next = xml.indexOf('<', i)
    const text = next === -1 ? xml.slice(i) : xml.slice(i, next)
    if (bareAmpersand(text)) return `bare & in text near ${JSON.stringify(text.trim().slice(0, 40))}`
    // Forbidden in content, and the exact hole an unguarded CDATA section has.
    if (text.includes(']]>')) return 'literal ]]> in text'
    if (next === -1) break

    // Declarations, comments and processing instructions carry no structure.
    if (xml.startsWith('<!--', next)) {
      const close = xml.indexOf('-->', next)
      if (close === -1) return 'unterminated comment'
      i = close + 3
      continue
    }
    if (xml.startsWith('<?', next) || xml.startsWith('<!', next)) {
      const close = xml.indexOf('>', next)
      if (close === -1) return 'unterminated declaration'
      i = close + 1
      continue
    }

    const end = xml.indexOf('>', next)
    if (end === -1) return 'unterminated tag'
    const tag = xml.slice(next + 1, end)
    if (tag.includes('<')) return 'a < inside a tag'

    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim()
      if (stack.pop() !== name) return `</${name}> does not close the element that is open`
      if (stack.length === 0) roots++
    } else {
      const name = tag.match(/^[^\s/>]+/)?.[0]
      if (!name) return 'a tag with no name'
      if (bareAmpersand(tag)) return `bare & in an attribute of <${name}>`
      const attrs = tag.slice(name.length).replace(/\/$/, '')
      if (/=\s*[^"'\s]/.test(attrs)) return `unquoted attribute value in <${name}>`
      if (tag.endsWith('/')) {
        if (stack.length === 0) roots++
      } else {
        stack.push(name)
      }
    }
    i = end + 1
  }

  if (stack.length > 0) return `unclosed <${stack[stack.length - 1]}>`
  if (roots !== 1) return `${roots} root element(s), expected 1`
  return null
}

/**
 * The assertions the feed feature owes, both halves.
 *
 * A function taking `pages`, like `thirdPartyOrigins()` above and for the same
 * reason: on the committed config `url` is unset, so `features.rss` cannot be
 * on, every check below is vacuously true and deleting the section outright
 * would change nothing. the theme suite rebuilds with the feed on and runs it again
 * against real output, which is what gives it teeth.
 *
 * `MAX_ITEMS` is duplicated from `src/lib/feed.ts` rather than imported: this
 * is a `.mjs` script and that is a TypeScript module. Kept as a named constant
 * so a change there fails here loudly rather than widening the assertion.
 */
export const FEED_MAX_ITEMS = 50

export async function feedSection(pages) {
  const xml = await readFile(join(DIST, 'rss.xml'), 'utf8').catch(() => null)

  const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? ''
  /**
   * Vault attachments are copied into `dist/_vault/` with no extension
   * allowlist, so an `.html` file a note links to is in `pages` and is not
   * jotter's markup: the same exemption `thirdPartyOrigins` names, for the
   * same reason.
   */
  const authored = pages.filter(({ file }) => !file.startsWith(`_vault${sep}`))
  const alternates = authored.flatMap(({ file, html }) =>
    [...html.matchAll(/<link\b[^>]*>/g)]
      .filter((m) => attr(m[0], 'rel') === 'alternate')
      .map((m) => ({ file, tag: m[0] })),
  )

  if (!xml) {
    /**
     * Off means absent in *both* halves (no file, and no page advertising one)
     * which is the pairing `search off writes no dist/pagefind/` already
     * uses. A `rel="alternate"` pointing at a file that was never written is a
     * reader subscribing to a 404.
     */
    pass('no feed in dist/', 'features.rss is off')
    check(
      alternates.length === 0,
      'rss off leaves no rel="alternate" link on any page',
      alternates.map((a) => a.file).join(', '),
    )
    return
  }

  const problem = xmlWellFormed(xml)
  check(problem === null, 'the feed is well-formed XML', problem ?? '')

  /** Everything before the first `<item>`: the channel's own children. */
  const firstItem = xml.indexOf('<item>')
  const channel = firstItem === -1 ? xml : xml.slice(0, firstItem)

  // The three RSS requires. An empty one is as invalid as a missing one.
  for (const element of ['title', 'link', 'description']) {
    check(
      new RegExp(`<${element}>[^<]+</${element}>`).test(channel),
      `the channel carries a non-empty <${element}>`,
    )
  }
  check(/<language>[^<]+<\/language>/.test(channel), 'the channel declares a <language>')

  /**
   * The profile requires it and the W3C validator warns without it. Quartz
   * omits both this and the namespace it needs, which is why it is asserted
   * rather than assumed.
   */
  const self = channel.match(/<atom:link\b[^>]*\brel="self"[^>]*>/)?.[0] ?? ''
  check(!!self, 'the feed names its own address with atom:link rel="self"')
  check(xml.includes('xmlns:atom="http://www.w3.org/2005/Atom"'), 'the atom namespace is declared')

  const selfHref = attr(self, 'href')
  let origin = ''
  try {
    origin = new URL(selfHref).origin
  } catch {
    fail('atom:link rel="self" carries an absolute URL', selfHref || '(none)')
  }

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1])
  check(items.length > 0, 'the feed actually has items')
  check(
    items.length <= FEED_MAX_ITEMS,
    `the feed is within its ${FEED_MAX_ITEMS}-item cap`,
    `${items.length} items`,
  )

  const value = (body, element) =>
    body.match(new RegExp(`<${element}(?:\\s[^>]*)?>([\\s\\S]*?)</${element}>`))?.[1] ?? ''

  /**
   * A relative link in a feed resolves against nothing (the reader has no
   * document to resolve it in), and an off-origin one is a leak or a mistake.
   * This is the check that `config.url` reached every URL the feed emits.
   */
  const offOrigin = []
  const guidless = []
  const badPub = []
  const badUpdated = []

  const RFC_822 = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/
  const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
  const parses = (v) => !Number.isNaN(new Date(v).getTime())

  for (const body of items) {
    const title = value(body, 'title')
    for (const [element, url] of [
      ['link', value(body, 'link')],
      ['guid', value(body, 'guid')],
    ]) {
      let same = false
      try {
        same = new URL(url).origin === origin
      } catch {
        same = false
      }
      if (!same) offOrigin.push(`${title}: <${element}>${url}`)
    }
    if (!/<guid\b[^>]*\bisPermaLink="(?:true|false)"/.test(body)) guidless.push(title)

    const pub = value(body, 'pubDate')
    const updated = value(body, 'atom:updated')
    if (!RFC_822.test(pub) || !parses(pub)) badPub.push(`${title}: ${pub || '(none)'}`)
    if (!RFC_3339.test(updated) || !parses(updated)) badUpdated.push(`${title}: ${updated || '(none)'}`)
  }

  check(offOrigin.length === 0, 'every item link and guid is absolute and on the site’s own origin', offOrigin.join('\n        '))

  /**
   * Unique, because the guid is the *only* thing a reader dedupes on. Two items
   * sharing one collapse into a single entry in every reader, and the note that
   * loses is one a subscriber is never shown.
   *
   * It is also the cheapest signal available for a config problem that has
   * nothing to do with the feed: two notes both claiming `/`, which happens
   * when `homepage:` names a note *and* the vault has an `index.md`. jotter
   * routes one of them and the other gets no page at all: a site-wide bug the
   * feed does not cause and cannot fix, but can at least name.
   */
  const guids = items.map((body) => value(body, 'guid'))
  const duplicated = [...new Set(guids.filter((g, i) => guids.indexOf(g) !== i))]
  check(
    duplicated.length === 0,
    'every guid is unique, so no item is deduped away by a reader',
    duplicated.length
      ? `${duplicated.join(', ')}: two notes claim the same URL; check whether \`homepage:\` names a note while the vault also has an index note`
      : '',
  )
  check(guidless.length === 0, 'every guid states isPermaLink rather than trusting the default', guidless.join(', '))
  check(badPub.length === 0, 'every <pubDate> is RFC-822', badPub.join('\n        '))
  check(badUpdated.length === 0, 'every <atom:updated> is RFC-3339', badUpdated.join('\n        '))

  /**
   * The check that catches the two date elements being wired to the same value,
   * which no format test can see: both would still parse, and the feed would
   * still validate. The demo garden has notes with distinct `created:` and
   * `updated:` frontmatter, so at least one item must differ, and if that ever
   * stops being true, this fails and says so rather than passing vacuously.
   */
  const revised = items.filter(
    (body) => new Date(value(body, 'pubDate')).getTime() !== new Date(value(body, 'atom:updated')).getTime(),
  )
  check(
    revised.length > 0,
    'a revised note publishes at created and updates at updated',
    'every item has pubDate === atom:updated, so both are wired to the same date',
  )

  /**
   * The discovery half. Without a `rel="alternate"` the file is findable only
   * by guessing its name, and one pointing anywhere but at the feed that was
   * actually written is a subscription that silently never updates.
   */
  const unadvertised = authored.filter(({ file }) => !alternates.some((a) => a.file === file))
  check(unadvertised.length === 0, 'every page advertises the feed', unadvertised.map((p) => p.file).join(', '))
  const wrongHref = alternates.filter((a) => attr(a.tag, 'href') !== selfHref)
  check(
    wrongHref.length === 0,
    'every rel="alternate" resolves to the feed that was written',
    wrongHref.map((a) => `${a.file}: ${attr(a.tag, 'href')}`).join(', '),
  )

  pass(
    'feed',
    `${items.length} item(s) at ${selfHref}, ${Math.round(Buffer.byteLength(xml) / 1024)} KB`,
  )
}

/* ---------------------------------------------------------- social cards */

/**
 * The `<head>` assertion this file has never had.
 *
 * `section('Markup')` checks landmarks, `lang`, a non-empty `<title>` and `alt`
 * on every `<img>`: page *structure*. Until this, the only `<head>` assertion
 * in the file lived inside `feedSection` and was about `rel="alternate"`, so
 * the canonical link, every `og:*` tag and `twitter:card` were emitted by a
 * layout nothing checked. That is the same shape of hole the Links section had
 * before `internalLinks()`, and it is closed the same way: the feature brings
 * the assertion its own surface owes.
 *
 * Written as a function, like `thirdPartyOrigins()` and `internalLinks()`,
 * because two passes call it. On the committed config `url` is unset, so no
 * card image can be absolute and none is emitted: the negative half below,
 * which is the half that bites here. the theme suite re-runs it against the rss-on
 * rebuild, which already sets `url` and additionally sets `config.image`.
 */
export async function socialCards(pages) {
  const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? ''
  const metas = (html) => [...html.matchAll(/<meta\b[^>]*>/g)].map((m) => m[0])
  /** `og:*` is spelled `property`, `twitter:*` `name`. Both are asserted. */
  const content = (html, kind, key) =>
    metas(html).filter((tag) => attr(tag, kind) === key).map((tag) => attr(tag, 'content'))

  const authored = authoredOf(pages)
  const cards = authored.map(({ file, html }) => ({
    file,
    og: content(html, 'property', 'og:image'),
    twitter: content(html, 'name', 'twitter:image'),
    card: content(html, 'name', 'twitter:card')[0] ?? '',
  }))

  const withImage = cards.filter((c) => c.og.length > 0 || c.twitter.length > 0)

  if (withImage.length === 0) {
    /**
     * Off means absent in *both* halves, the pairing `rss off leaves no
     * rel="alternate"` already uses. `summary_large_image` with no image is a
     * card that unfurls as a blank slab, so the card type has to move with it.
     */
    pass('no og:image in dist/', 'config.url is unset, or nothing declares an image')
    const large = cards.filter((c) => c.card !== 'summary')
    check(
      large.length === 0,
      'a site with no card image leaves twitter:card at summary',
      large.map((c) => `${c.file}: ${c.card || '(none)'}`).join(', '),
    )
    return
  }

  /**
   * Exactly one of each, on every page. None means a page template that
   * bypasses `Base.astro`; two means an unfurler picking whichever it read
   * first, which is a card nobody chose.
   */
  const miscounted = cards.filter((c) => c.og.length !== 1 || c.twitter.length !== 1)
  check(
    miscounted.length === 0,
    'every page carries exactly one og:image and one twitter:image',
    miscounted.map((c) => `${c.file}: ${c.og.length} og, ${c.twitter.length} twitter`).join(', '),
  )

  const disagree = cards.filter((c) => (c.og[0] ?? '') !== (c.twitter[0] ?? ''))
  check(
    disagree.length === 0,
    'og:image and twitter:image name the same picture',
    disagree.map((c) => c.file).join(', '),
  )

  /**
   * Absolute, always. A relative `og:image` is not a degraded card (an
   * unfurler has no document to resolve it against) it is one nobody draws,
   * which is why the whole feature is gated on `config.url`.
   */
  const relative = cards.filter((c) => !/^https?:\/\//i.test(c.og[0] ?? ''))
  check(
    relative.length === 0,
    'every og:image is an absolute URL',
    relative.map((c) => `${c.file}: ${c.og[0] || '(none)'}`).join(', '),
  )

  /**
   * The site's own origin, read off the canonical link rather than guessed from
   * the images: that is `config.url` itself, so an image on it is one this
   * build was supposed to have written.
   */
  const canonical = authored
    .map(({ html }) => html.match(/<link\b[^>]*rel="canonical"[^>]*>/)?.[0] ?? '')
    .find(Boolean)
  let siteOrigin = ''
  try {
    siteOrigin = new URL(attr(canonical ?? '', 'href')).origin
  } catch {
    fail('the canonical link carries an absolute URL', 'og:image cannot be checked against dist/')
  }

  const sameOrigin = (url) => {
    try {
      return new URL(url).origin === siteOrigin
    } catch {
      return false
    }
  }

  /**
   * The sibling of "every `rel="alternate"` resolves to the feed that was
   * written": a card pointing at a path `dist/` does not serve is a preview
   * that renders blank, and nothing else in the build would notice.
   */
  const ours = [...new Set(cards.map((c) => c.og[0]).filter((url) => url && sameOrigin(url)))]
  const unserved = []
  for (const url of ours) {
    const path = decodeURIComponent(new URL(url).pathname).split('/').join(sep)
    if (!(await stat(join(DIST, path)).catch(() => null))) unserved.push(url)
  }
  check(
    unserved.length === 0,
    'every card image on the site’s own origin is a file dist/ actually serves',
    unserved.join('\n        '),
  )
  // Without this the check above passes loudest on a build whose every card
  // image points at somebody else's host, which is a perfectly ordinary thing
  // for a vault to do, and only the demo owes an image of its own.
  demo(ours.length > 0, 'at least one card image is served from dist/ itself')

  const wrongCard = cards.filter((c) => c.card !== (c.og.length > 0 ? 'summary_large_image' : 'summary'))
  check(
    wrongCard.length === 0,
    'twitter:card is summary_large_image exactly when there is an image',
    wrongCard.map((c) => `${c.file}: ${c.card || '(none)'}`).join(', '),
  )

  /**
   * The precedence assertion, and what stops the rest of this being vacuous: a
   * note that declares its own `image:` must carry *that*, resolved through the
   * vault, rather than the site-wide default every other page carries. Drop the
   * prop out of `Note.astro` and every check above still passes.
   */
  const OWN = '/_vault/attachments/slipbox.png'
  const sink = cards.find((c) => c.file.includes('kitchen-sink'))
  if (!sink) {
    demo(false, 'the note that sets image: in frontmatter has a page', 'kitchen-sink not found in dist/')
  } else {
    demo(
      decodeURIComponent(sink.og[0] ?? '').endsWith(OWN),
      'a note’s own image: beats the site-wide default',
      `${sink.file}: ${sink.og[0] || '(none)'}, wanted one ending ${OWN}`,
    )
  }

  pass('social cards', `${withImage.length}/${cards.length} page(s), ${ours.length} from dist/`)
}

/* --------------------------------------------------- running a rebuild */

export const spawned = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'pipe', ...options })
    let out = ''
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('exit', (code) => resolve({ code, out }))
  })

export const run = (args, options = {}) => spawned('npx', args, options)

/** The Open Publish scripts, which are plain Node rather than a bin on PATH. */
export const runNode = (args, options = {}) => spawned(process.execPath, args, options)



/**
 * What the run added up to, and the exit code that follows from it.
 *
 * Shared, so both suites report the three counts in the same words: a `note` is
 * never a failure and a `skip` is never a silence, and a person reading either
 * log should not have to learn that twice.
 */
export function summary(closing) {
  console.log('')
  if (skipped) {
    console.log(
      `${skipped} check(s) skipped: they guard this repository's own demo fixtures, ` +
        'and this build is a vault. CI runs them with JOTTER_DEMO=1.',
    )
  }
  if (observations) {
    console.log(
      `${observations} observation(s) about this site's content. None of them is a defect in ` +
        'jotter and none of them stopped this build; they are listed above as `note`.',
    )
  }
  if (failures) {
    console.error(
      `${failures} invariant(s) broken. These are claims jotter makes about every site it ` +
        'builds, so this is a bug in the theme rather than in the vault. ' +
        'See "Two kinds of verify failure" in docs/open-publish.md.',
    )
    process.exit(1)
  }
  console.log(closing)
}
