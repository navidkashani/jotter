#!/usr/bin/env node
/**
 * Assertions over a real `dist/`, run after `astro build`.
 *
 * These are the claims jotter makes that a unit test cannot check, because they
 * are only true of the finished HTML: that a dead link is inert, that no
 * unpublished note leaked, that the palette meets AA, that a disabled feature
 * ships no JavaScript, and that Astro 7's `compressHTML: 'jsx'` default did not
 * quietly eat the spaces between inline elements.
 *
 *   npm run verify          the checks below, over the current dist/
 *   npm run verify:full     also rebuilds with features off, analytics on, RSS on,
 *                           a homepage set, and at scale
 *
 * ## Three kinds of claim, and only one of them stops a deploy
 *
 * This script runs in `npm run build`, ahead of `finalize.mjs`, so whatever it
 * fails on is a site that does not go live. That makes the distinction below
 * the most important thing in the file:
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
 * The distinction is not decoration. A gate that fails a deploy over content
 * the author is entitled to write teaches people to delete the gate, and a
 * user of this theme did exactly that: 96 notes, 114 pages, every content check
 * green, and eight failures. Five of them were anti-vacuity guards about
 * fixtures that only exist in this repository; three were true statements
 * about a vault that embeds a YouTube link and keeps its notes in a folder
 * called `notes`. Their site is live because they removed this script from
 * their build command. Every check added here should be able to answer: *whose
 * fault is it when this fails, and should that person's site stop shipping
 * over it?*
 */
import { readFile, readdir, stat, mkdir, writeFile, rm } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { join, relative, extname, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

import { readTokens, contrastOklch } from './lib/color.mjs'
import { runningDevServers, devServerWarning } from './lib/dev-server.mjs'
import { clearContentStores } from './lib/astro-cache.mjs'

const ROOT = join(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const FULL = process.argv.includes('--full')

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
const DEMO = Boolean(process.env.JOTTER_DEMO)

let failures = 0
let observations = 0
let skipped = 0

const pass = (label, detail = '') => console.log(`  ok    ${label}${detail ? `  ${detail}` : ''}`)
const fail = (label, detail = '') => {
  failures++
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
}
const note = (label, detail = '') => {
  observations++
  console.log(`  note  ${label}${detail ? `\n        ${detail}` : ''}`)
}
const skip = (label) => {
  skipped++
  console.log(`  skip  ${label}`)
}

/** An invariant jotter guarantees. A failure is jotter's, and stops the build. */
const check = (ok, label, detail = '') => (ok ? pass(label) : fail(label, detail))

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
const observe = (ok, label, detail = '', { strictInDemo = false } = {}) =>
  strictInDemo && DEMO ? check(ok, label, detail) : ok ? pass(label) : note(label, detail)

/**
 * A guard that this repository's demo still covers the case the assertions
 * beside it are about. Meaningless anywhere else: a vault with no SVG, no dead
 * links and no `kitchen-sink` page is an ordinary vault, and it must deploy.
 */
const demo = (ok, label, detail = '') => (DEMO ? check(ok, label, detail) : skip(label))

const section = (title) => console.log(`\n${title}`)

async function walk(dir, filter, out = []) {
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

if (!(await stat(DIST).catch(() => null))) {
  console.error('No dist/. Run `astro build` first.')
  process.exit(1)
}

const htmlFiles = await walk(DIST, (n) => n.endsWith('.html'))
const pages = await Promise.all(
  htmlFiles.map(async (file) => ({ file: relative(DIST, file), html: await readFile(file, 'utf8') })),
)

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
const TEXT_OUTPUT = /\.(?:html|xml|json|txt|css|js|map|webmanifest)$/i
const textFiles = await walk(DIST, (n) => TEXT_OUTPUT.test(n) || n === '_redirects')
const outputs = await Promise.all(
  textFiles.map(async (file) => ({ file: relative(DIST, file), text: await readFile(file, 'utf8') })),
)

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
const routeOf = (file) =>
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
const pageFileFor = (slug) =>
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
const encodePath = (slug) =>
  slug.split('/').map((s) => encodeURIComponent(s).replace(/%2B/g, '+')).join('/')

const decodePath = (path) =>
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
const authoredOf = (pages) => pages.filter(({ file }) => !file.startsWith(`_vault${sep}`))
const authored = authoredOf(pages)

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
const NOTE_BODY = '<div class="note-body prose">'

function proseParts(html) {
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

const proseOf = (html) => proseParts(html).join('\n')

/** The page minus the note body: nav, breadcrumb, rail, listings, `<head>`. */
const chromeOf = (html) =>
  proseParts(html).reduce((rest, part) => (part ? rest.replace(part, '') : rest), html)

/**
 * Offenders in a set of pages, kept apart by which half of the page they were
 * found in. `find` is given one region and returns what is wrong with it.
 */
function byRegion(pages, find) {
  const chrome = []
  const prose = []
  for (const { file, html } of pages) {
    for (const hit of find(chromeOf(html))) chrome.push(`${file}: ${hit}`)
    for (const hit of find(proseOf(html))) prose.push(`${file}: ${hit}`)
  }
  return { chrome, prose }
}

console.log(`Verifying ${pages.length} page(s) in dist/`)
console.log(
  DEMO
    ? "  as this repository's own demo garden, because JOTTER_DEMO is set"
    : '  as a site built from a vault',
)
console.log('')
console.log('  FAIL  a claim jotter guarantees about every site is broken. The build stops.')
console.log('  note  something true of this site’s own content. The build carries on.')
if (!DEMO) console.log('  skip  a guard on this repository’s demo fixtures, which this build is not.')
if (FULL && !DEMO) {
  console.log('')
  console.log('  --full without JOTTER_DEMO=1: the demo-integrity guards below are skipped.')
  console.log('  CI sets it, and that is what makes a green run mean the demo still covers them.')
}
console.log('')

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
 * reason: `--full` re-runs it against a build with `homepage:` set, which is
 * the config mode that had nothing checking it.
 */
async function internalLinks(pages) {
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
 * the hrefs alone and says how much it covered. `--full` sets both.
 */
async function producersAgree(pages) {
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

section('Links')
{
  const emptyHref = authored.filter(({ html }) =>
    /<a\b[^>]*href=(""|'')/.test(html) || /href="undefined"/.test(html) || /href="null"/.test(html),
  )
  check(emptyHref.length === 0, 'no <a> with an empty, undefined or null href', emptyHref.map((p) => p.file).join(', '))

  const anchorDeadLinks = authored.filter(({ html }) => /<a\b[^>]*class="[^"]*dead-link/.test(html))
  check(anchorDeadLinks.length === 0, 'every dead link is a <span>, never an <a>', anchorDeadLinks.map((p) => p.file).join(', '))

  const hrefOnSpan = authored.filter(({ html }) => /<span\b[^>]*\bhref=/.test(html))
  check(hrefOnSpan.length === 0, 'no href attribute left on a dead-link span', hrefOnSpan.map((p) => p.file).join(', '))

  const deadLinkPages = authored.filter(({ html }) => html.includes('class="dead-link"'))
  demo(deadLinkPages.length > 0, 'the demo actually exercises dead links', 'no dead-link span found anywhere')

  /**
   * Every link off the site carries `rel="noopener"`, and none is `nofollow`ed.
   *
   * `<a href>` is deliberately outside the third-party-origin sweep further
   * down (a link is not a subresource; nothing is fetched until a reader
   * clicks), which is why this belongs here instead.
   *
   * `noopener` only. `nofollow` is Obsidian Publish's answer and it is the
   * wrong one for a knowledge garden: those links are citations, and stripping
   * their credit is not a theme's call. See `config.externalLinks`.
   *
   * **An observation on a vault, an invariant on the demo**, and the split is
   * the whole point. Every anchor jotter *generates* carries the attributes,
   * so on this repository's own garden a miss is a regression and fails. On
   * somebody's vault the same measurement reads differently: a note containing
   * raw HTML (`<a href="https://…" rel="nofollow">`, pasted from anywhere)
   * never passes through the markdown pipeline that adds them, and refusing to
   * deploy over it would be this script failing a build for content the author
   * is entitled to write. That is how a user came to delete this script from
   * their build command.
   */
  const OFF_SITE_ANCHOR = /<a\b[^>]*\bhref="(?:https?:)?\/\/[^"]*"[^>]*>/gi
  const unprotected = []
  const nofollowed = []
  let offSiteCount = 0
  for (const { file, html } of authored) {
    for (const [tag] of html.matchAll(OFF_SITE_ANCHOR)) {
      offSiteCount++
      if (!/\brel="[^"]*\bnoopener\b[^"]*"/i.test(tag)) unprotected.push(`${file}: ${tag}`)
      if (/\brel="[^"]*\bnofollow\b[^"]*"/i.test(tag)) nofollowed.push(`${file}: ${tag}`)
    }
  }
  observe(
    unprotected.length === 0,
    'every link off the site carries rel="noopener"',
    unprotected.slice(0, 5).join('\n        '),
    { strictInDemo: true },
  )
  observe(
    nofollowed.length === 0,
    'and none of them is nofollowed, so a cited source keeps the credit',
    nofollowed.slice(0, 5).join('\n        '),
    { strictInDemo: true },
  )
  demo(offSiteCount > 0, 'the demo actually links off the site', 'no external anchor found anywhere')

  await internalLinks(pages)
  await producersAgree(pages)
}

/* ----------------------------------------------------------------- routes */

/**
 * No two routes write the same file.
 *
 * `build.format: 'file'` is what makes this worth asserting. Under the
 * `directory` format a page's output path carries its own directory
 * (`dist/about/index.html`), so two routes could only collide by being the same
 * route; under `file` the directory is gone (`dist/about.html`), and
 * `src/pages/about.astro` beside `src/pages/about/index.astro` is two ordinary
 * files that quietly write one page. Whichever renders second wins, `dist/`
 * shows no sign of it, and every other assertion in this script passes.
 *
 * Two nets, because a collision is visible in two different places and neither
 * sees the other's case:
 *
 * 1. **The source tree**, for two static route files sharing an output path.
 *    That is the pair above, and it cannot be seen in `dist/` at all: there is
 *    one file there, and it looks correct.
 * 2. **`dist/` itself**, for two files serving one address. That is a mixed or
 *    stale output directory (`about.html` left beside `about/index.html` by a
 *    build under the other format), where the host picks one and the other is
 *    unreachable.
 *
 * The third kind of collision, a note and a folder claiming one slug, is not
 * here: `src/pages/[...slug].astro` resolves it deliberately (the note wins)
 * and says so, which is a decision about content rather than a defect in the
 * build.
 */
async function routeCollisions() {
  const PAGES_DIR = join(ROOT, 'src', 'pages')
  const routeFiles = await walk(PAGES_DIR, (n) => /\.(astro|md|mdx|html|ts|js)$/.test(n))

  /** Every static route file, as the path in `dist/` it writes. */
  const emitted = new Map()
  const clashes = []
  for (const file of routeFiles) {
    const rel = relative(PAGES_DIR, file).split(sep).join('/')
    // A dynamic route's output paths come from `getStaticPaths`, so there is
    // nothing to compare here; net 2 below is what covers those.
    if (rel.includes('[')) continue
    const route = rel.replace(/\.(astro|md|mdx|html|ts|js)$/, '').replace(/(^|\/)index$/, '$1')
    const out = `${route.replace(/\/$/, '') || 'index'}.html`
    const first = emitted.get(out)
    if (first) clashes.push(`${first} and ${rel} both write ${out}`)
    else emitted.set(out, rel)
  }
  check(
    clashes.length === 0,
    'no two page files in src/pages write the same file',
    clashes.join('\n        '),
  )

  /** And no two files already in `dist/` answer at one address. */
  const served = new Map()
  const duplicated = []
  for (const file of htmlFiles) {
    if (relative(DIST, file).startsWith(`_vault${sep}`)) continue
    const route = routeOf(file)
    const first = served.get(route)
    if (first) duplicated.push(`${first} and ${relative(DIST, file)} are both served at ${route}`)
    else served.set(route, relative(DIST, file))
  }
  check(
    duplicated.length === 0,
    'every page in dist/ is the only file served at its address',
    duplicated.join('\n        '),
  )

  /**
   * And the format really is the one the paths above assume. A silent revert to
   * `directory` would leave both checks green and put every internal link on
   * the site back behind a 308.
   */
  const directoryPages = htmlFiles.filter(
    (file) =>
      relative(DIST, file).endsWith(`${sep}index.html`) &&
      !relative(DIST, file).startsWith(`_vault${sep}`),
  )
  check(
    directoryPages.length === 0,
    'pages are written as <slug>.html, so no internal link takes a redirect',
    directoryPages.map((f) => relative(DIST, f)).join(', '),
  )
}

section('Routes')
await routeCollisions()

/* ----------------------------------------------------------------- images */

section('Images')
{
  /** Extensions that are a file rather than a picture, however they are dressed. */
  const NOT_AN_IMAGE = /\.(pdf|mp4|webm|mov|ogv|mp3|wav|m4a|ogg|flac)(?:[?#]|$)/i

  /**
   * Reserved space, so nothing below the image moves when it arrives.
   *
   * jotter fills the dimensions in for every embed it can measure: Astro's
   * pipeline supplies them for the rasters it processes, `svgIntrinsicSize`
   * reads them out of an SVG, and an author's `![[x.png|320]]` pipe overrides
   * both. What is left over is genuinely outside its reach: a GIF, a remote
   * URL, an `<img>` an author hand-wrote in raw HTML. None of those is a
   * reason a site cannot go live. Split accordingly.
   */
  const missing = byRegion(authored, (region) =>
    [...region.matchAll(/<img\b[^>]*>/g)]
      .map(([tag]) => tag)
      .filter((tag) => !/\bwidth=/.test(tag) || !/\bheight=/.test(tag))
      .map((tag) => tag.slice(0, 120)),
  )
  check(
    missing.chrome.length === 0,
    'every <img> jotter emits declares width and height',
    missing.chrome.join('\n        '),
  )
  observe(
    missing.prose.length === 0,
    'every <img> in a note declares width and height',
    missing.prose.join('\n        '),
    { strictInDemo: true },
  )

  const total = authored.reduce((n, p) => n + [...p.html.matchAll(/<img\b/g)].length, 0)
  demo(total > 0, 'the demo actually renders images')

  /**
   * And that they are pictures.
   *
   * A `check()` and not a `demo()`, because the element is jotter's choice and
   * never the author's: an author writes `![[Integrity.pdf]]` and this theme
   * decides what to emit for it. When that decision is wrong the reader gets a
   * broken-image icon on every browser there is, and for a long while nothing
   * here noticed: the two PDFs and a tweet URL that were the *only* `<img>`
   * tags on a page satisfied "the demo actually renders images" above, and the
   * width and height check reported the bug as a missing attribute.
   *
   * Whole-page rather than split by region, unlike the sweep above it, and the
   * closed list is why. This does not ask whether jotter recognises the
   * extension; it names nine that are certainly not pictures. A GIF, a remote
   * URL and `scan.tiff` all pass it, which is to say the three content cases
   * that make the check above an `observe()` cannot fail this one.
   */
  const notPictures = authored.flatMap(({ file, html }) =>
    [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)]
      .filter(([, src]) => NOT_AN_IMAGE.test(src))
      .map(([tag]) => `${file}: ${tag.slice(0, 120)}`),
  )
  check(
    notPictures.length === 0,
    'no <img> points at something that is not an image',
    notPictures.join('\n        '),
  )

  /**
   * And that an embedded document is reachable without the frame.
   *
   * `<iframe>` has no fallback content in static markup, so a phone that
   * refuses the PDF shows a blank box. The link beside it is the only way
   * forward from there, which makes "there is one" an invariant rather than a
   * nicety. Matched on the file rather than on the class, so the check still
   * holds if the card is ever restyled or renamed.
   */
  const framesWithoutLink = authored.flatMap(({ file, html }) =>
    [...html.matchAll(/<iframe\b[^>]*\bsrc="([^"?#]+)[^"]*"/g)]
      .map(([, src]) => src)
      .filter((src) => /\.pdf$/i.test(src) && !html.includes(`<a class="file-embed" href="${src}"`))
      .map((src) => `${file}: ${src}`),
  )
  check(
    framesWithoutLink.length === 0,
    'every embedded document ships a link to itself beside the frame',
    framesWithoutLink.join('\n        '),
  )

  const optimized = authored.some(({ html }) => /<img[^>]+src="\/_astro\/[^"]+\.(webp|avif)"/.test(html))
  demo(optimized, 'raster embeds go through Astro’s image pipeline')

  const svgPassthrough = authored.some(({ html }) => /<img[^>]+src="\/_vault\/[^"]+\.svg"/.test(html))
  demo(svgPassthrough, 'SVG is passed through rather than re-encoded')
}

/* ------------------------------------------------------- the privacy gate */

/**
 * Every check in this section names a fixture: `Half-formed.md` and the title
 * inside it, which exist in `src/content/notes/` and nowhere else. On a vault
 * that is not this one they are four green ticks over an empty set, the exact
 * false green this file's header is about, so they say so instead.
 *
 * The general form, "no note the gate excluded appears in `dist/`", is a real
 * and much better check, and it is not this one: it would have to read the
 * vault's frontmatter rather than `dist/`. `test/vault.test.ts` holds the
 * publish gate's own logic; what runs here is the end-to-end proof that the
 * decision survives the build, and that proof needs a known excluded note.
 */
section('Publish gate')
{
  const PRIVATE_TITLE = 'A title that must never reach the site'
  // Over `outputs`, not `pages`: this is jotter's strongest privacy claim and
  // it should read every file that could carry a title out of the vault.
  const leaked = outputs.filter(({ text }) => text.includes(PRIVATE_TITLE))
  demo(leaked.length === 0, 'no unpublished note’s title appears anywhere in dist/', leaked.map((p) => p.file).join(', '))

  const routed = htmlFiles.some((f) => /half-formed/i.test(f))
  demo(!routed, 'no unpublished note has a page of its own')

  /**
   * Anchored on the ways a *URL* is written rather than on the slug alone. The
   * name legitimately appears as text in the demo: `Kitchen sink.md` links to
   * `[[Half-formed]]`, which renders as a dead-link span showing the filename
   * the author typed, which is the documented behaviour. What must never appear
   * is a link that resolves to it, and in a feed those are `<link>` and
   * `<guid>` rather than `href=`.
   */
  const linkedTo = outputs.filter(({ text }) =>
    /(?:href="|<link>|<guid[^>]*>)[^"<]*half-formed/i.test(text),
  )
  demo(!linkedTo.length, 'nothing links to an unpublished note', linkedTo.map((p) => p.file).join(', '))
}

/* -------------------------------------------- the compressHTML: jsx trap */

section('Inline whitespace (the compressHTML: \'jsx\' trap)')
{
  const kitchenSink = authored.find((p) => p.file.includes('kitchen-sink'))
  if (!kitchenSink) {
    /**
     * The probe is a note in this repository's demo garden carrying one line
     * written to catch the trap. There is nothing for it to be on a vault that
     * does not have it, and the trap it catches is jotter-wide:
     * `test/inline.test.ts` covers the same ground on a fixture, every build.
     */
    demo(false, 'the whitespace probe page exists', 'kitchen-sink not found in dist/')
  } else {
    const { html } = kitchenSink
    // Source line: `Probe: word *emphasis* [[Zettelkasten]] `code` **strong** end.`
    const expected = [
      ['space before <em>', /Probe: word <em>emphasis<\/em>/],
      ['space between </em> and the link', /<\/em> <a href="\/zettelkasten"/],
      ['space between </a> and <code>', /<\/a> <code>code<\/code>/],
      ['space between </code> and <strong>', /<\/code> <strong>strong<\/strong>/],
      ['space after </strong>', /<\/strong> end\./],
    ]
    for (const [label, pattern] of expected) {
      demo(pattern.test(html), label, 'whitespace was stripped between inline elements')
    }
  }

  // Anything else in the demo where two inline elements touch with no
  // separator is suspicious, but a user's own prose can do this legitimately,
  // so it is reported rather than failed.
  const adjacency = /<\/(a|em|strong|code|mark)><(a|em|strong|code|mark)[\s>]/g
  const suspicious = authored.filter((p) => adjacency.test(proseOf(p.html)))
  observe(
    suspicious.length === 0,
    'no inline elements touching with no separator',
    suspicious.map((p) => p.file).join(', '),
  )
}

/* -------------------------------------------------------------- structure */

section('Markup')
{
  /**
   * Astro 7's compiler no longer silently repairs invalid nesting, so this is
   * jotter's markdown output to get right, and an author writing raw HTML in
   * a note can produce the same shape, which is not jotter's to fail them for.
   */
  const nested = authored.filter(({ html }) =>
    /<p>(?:(?!<\/p>)[\s\S])*?<(figure|div class="callout"|details|aside|blockquote|table|pre)/.test(proseOf(html)),
  )
  observe(
    nested.length === 0,
    'no block element nested inside a <p>',
    nested.map((p) => p.file).join(', '),
    { strictInDemo: true },
  )

  const landmarks = authored.filter(({ html }) => !/<main\b/.test(html))
  check(landmarks.length === 0, 'every page has a <main> landmark', landmarks.map((p) => p.file).join(', '))

  const noSkipLink = authored.filter(({ html }) => !/class="skip-link"/.test(html))
  check(noSkipLink.length === 0, 'every page has a skip link', noSkipLink.map((p) => p.file).join(', '))

  const lang = authored.filter(({ html }) => !/<html[^>]+lang="/.test(html))
  check(lang.length === 0, 'every page declares a lang')

  const titled = authored.filter(({ html }) => !/<title>[^<]+<\/title>/.test(html))
  check(titled.length === 0, 'every page has a non-empty title')

  const altless = byRegion(authored, (region) =>
    [...region.matchAll(/<img\b[^>]*>/g)]
      .map(([tag]) => tag)
      .filter((tag) => !/\balt=/.test(tag))
      .map((tag) => tag.slice(0, 100)),
  )
  check(altless.chrome.length === 0, 'every <img> jotter emits has an alt attribute', altless.chrome.join('\n        '))
  // jotter always writes one, empty for a decorative embed. A hand-written
  // `<img>` in a note is the author's, and so is its accessibility.
  observe(
    altless.prose.length === 0,
    'every <img> in a note has an alt attribute',
    altless.prose.join('\n        '),
    { strictInDemo: true },
  )

  /**
   * No page shows a reader an i18n *key*.
   *
   * `t()` returns the key itself when it cannot find a string (deliberately,
   * so a missing translation is loud rather than a blank label), which means a
   * component naming a key that `en.json` does not have renders a literal
   * `note.field.series` into the markup. That is the failure mode
   * `DISPLAYED_FIELDS` walked into: the list of rendered frontmatter fields and
   * the list of labels were two lists nothing compared.
   *
   * `test/vault.test.ts` compares those two directly. This is the wider net
   * (every key, every component, every page, against the built HTML), and it
   * covers the labels a unit test cannot see because they are chosen inside an
   * `.astro` file.
   */
  const keys = Object.keys(JSON.parse(await readFile(join(ROOT, 'src/i18n/en.json'), 'utf8')))
  const leakedKeys = []
  for (const { file, html } of authored) {
    for (const key of keys) if (html.includes(key)) leakedKeys.push(`${file}: ${key}`)
  }
  check(
    leakedKeys.length === 0,
    'no page renders an i18n key instead of its string',
    leakedKeys.slice(0, 8).join('\n        '),
  )

  /**
   * And the frontmatter header block is actually exercised by the demo, so the
   * check above is not passing because nothing renders one. `Kitchen sink.md`
   * sets all four optional fields; the `<dt>` labels come from `en.json`.
   */
  const fieldRows = authored.filter(({ html }) =>
    /<dt>Status<\/dt>/.test(html) && /<dt>Source<\/dt>/.test(html) && /<dt>Series<\/dt>/.test(html),
  )
  demo(
    fieldRows.length > 0,
    'the demo renders a frontmatter field block',
    'no page sets status, source and series, so the label checks are vacuous',
  )
}

/* ------------------------------------------------------------- direction */

/**
 * Elements that never have a closing tag, and so never open a scope.
 * Without these the stack below would swallow every sibling of an `<img>`.
 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
])

/** Elements whose content is text, not markup. A `<` in here is not a tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])

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
function directionAttributes(html) {
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
const elementText = (html, end, tag) => {
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
const RTL_CHARACTER =
  /[֐-׿؀-ۿ܀-ݏހ-޿߀-߿ࠀ-࠿ࡀ-࡟ࢠ-ࣿיִ-﷿ﹰ-﻿]|[\u{10D00}-\u{10D3F}\u{1E900}-\u{1E95F}]/u

const LATIN_LETTER = /[A-Za-z]/

/**
 * Per-block text direction, over a real build.
 *
 * The unit tests own the rule; what only `dist/` can show is that the rule
 * reached the page, and, far more importantly, that it *stayed off* the
 * blocks that agree with it. Written as a function, like `internalLinks()`
 * above, because `--full` runs the whole thing again against a rebuild with
 * `dir: 'rtl'`. That mirror pass is the only thing that can prove the feature
 * is symmetric, and it is what would have caught the two defects the plan's
 * scenario pass found by hand.
 */
function directionSection(pages, outputs) {
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
   * literal `ltr`, so it is equally right on the `--full` RTL rebuild, where
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

section('Direction')
directionSection(pages, outputs)

/* ------------------------------------------------------------------- CSS */

/**
 * Source lints, not assertions about a built site.
 *
 * These read `src/`, and on anyone else's build `src/` is jotter upstream,
 * unmodified and already green in jotter's own CI, so running them there
 * checks nothing and can only misfire on the one file the config says is
 * theirs: `src/styles/custom.css`. A hex colour in a reader's own stylesheet is
 * not a defect in this theme, and it certainly is not a deploy failure.
 */
section('Design tokens')
{
  const cssFiles = await walk(join(ROOT, 'src', 'styles'), (n) => n.endsWith('.css'))
  const COLOUR = /(?:#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(|\b(?:red|blue|green|black|white|gray|grey|orange|purple|yellow|pink|brown)\b\s*[;,)])/i

  const offenders = []
  for (const file of cssFiles) {
    const name = file.split('/').pop()
    // tokens.css *is* the palette. print.css deliberately uses device-absolute
    // black and white: a printed page is not themed, and mapping ink to a
    // screen token would put grey text on paper.
    // `custom.css` is the reader's, named as theirs in `jotter.config.ts`.
    if (name === 'tokens.css' || name === 'print.css' || name === 'custom.css') continue

    const source = await readFile(file, 'utf8')
    source.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\*[\s\S]*?\*\//g, '')
      if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) return
      if (COLOUR.test(code) && !/var\(--/.test(code) && !/currentColor|transparent|inherit|none/i.test(code)) {
        offenders.push(`${name}:${i + 1}  ${line.trim()}`)
      }
    })
  }
  demo(offenders.length === 0, 'no colour literal outside tokens.css', offenders.join('\n        '))

  /**
   * Physical properties are how RTL support rots. Logical ones cost nothing.
   *
   * `text-align`, `float` and `clear` joined the list alongside the per-block
   * direction work: they are the three that survive a `padding-left` sweep and
   * still pin content to one side of the page. The repo was clean on all three
   * when this was widened, which is the cheapest possible moment to add a lint:
   * it goes in green, so it can only ever fail on something new.
   */
  const PHYSICAL =
    /(?:^|[\s;{])(?:padding|margin|border)-(?:left|right)\b|(?:^|[\s;{])(?:left|right|top|bottom)\s*:|(?:^|[\s;{])text-align\s*:\s*(?:left|right)\b|(?:^|[\s;{])(?:float|clear)\s*:/
  const physical = []
  for (const file of [...cssFiles, ...(await walk(join(ROOT, 'src'), (n) => n.endsWith('.astro')))]) {
    const name = relative(ROOT, file)
    if (name.endsWith('print.css') || name.endsWith('custom.css')) continue
    const source = await readFile(file, 'utf8')
    source.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\*[\s\S]*?\*\//g, '')
      if (/^\s*[*/]/.test(line)) return
      if (PHYSICAL.test(code)) physical.push(`${name}:${i + 1}  ${line.trim()}`)
    })
  }
  demo(physical.length === 0, 'no physical inset or spacing properties (RTL safety)', physical.join('\n        '))

  const tokensCss = await readFile(join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8')
  const light = readTokens(tokensCss, ':root {')
  const dark = readTokens(tokensCss, ":root[data-theme='dark']")

  const PAIRS = [
    ['--ink', '--paper', 4.5],
    ['--ink-strong', '--paper', 4.5],
    ['--ink-muted', '--paper', 4.5],
    ['--ink-faint', '--paper', 3],
    ['--accent', '--paper', 4.5],
    ['--accent-hover', '--paper', 4.5],
    ['--ink', '--surface', 4.5],
    ['--ink-muted', '--surface', 4.5],
    ['--accent-ink', '--accent', 4.5],
    ['--mark-ink', '--mark', 4.5],
    ['--focus', '--paper', 3],
  ]

  for (const [theme, tokens] of [['light', light], ['dark', dark]]) {
    const bad = []
    for (const [fg, bg, min] of PAIRS) {
      if (!tokens[fg] || !tokens[bg]) {
        bad.push(`${fg} or ${bg} missing from the ${theme} palette`)
        continue
      }
      const ratio = contrastOklch(tokens[fg], tokens[bg])
      if (ratio < min) bad.push(`${fg} on ${bg}: ${ratio.toFixed(2)} (needs ${min})`)
    }
    /**
     * Reported rather than asserted off the demo, because a fork may have
     * chosen its own palette and that is a choice, not a bug. What this reads
     * is `tokens.css` alone: an override in `custom.css` changes the shipped
     * site and is invisible here, so a green line means jotter's own palette
     * holds, and nothing more.
     */
    observe(bad.length === 0, `WCAG AA contrast holds in the ${theme} theme`, bad.join('\n        '), {
      strictInDemo: true,
    })
  }
}

/* ------------------------------------------------------------ redirects */

/**
 * A function, and re-walking `dist/` rather than closing over `htmlFiles`, for
 * the same reason `internalLinks()` and `thirdPartyOrigins()` are: `--full`
 * runs it again against the homepage build, which is the only one that emits a
 * redirect from a note's own vacated slug: precisely the kind that could
 * dangle or shadow.
 */
async function redirectsAndRobots() {
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

section('Redirects and robots')
await redirectsAndRobots()

/* -------------------------------------------------------------- payload */

section('JavaScript payload')
{
  const INLINE = /<script\b[^>]*>([\s\S]*?)<\/script>/g
  const scripts = pages.flatMap(({ file, html }) =>
    [...html.matchAll(INLINE)].map((m) => ({ file, body: m[1] })),
  )
  const jsFiles = await walk(DIST, (n) => n.endsWith('.js'))

  /**
   * Every emitted chunk, by the URL a page would reference it as.
   *
   * `imports` is what makes this survive contact with the future. There are no
   * cross-chunk imports in `dist/` today (one chunk, zero specifiers), so the
   * closure below is a no-op right now. It stops being one the first time
   * Rollup hoists a shared vendor chunk out of two islands, which is exactly
   * the day a check that only read `<script src>` would start under-counting.
   */
  const IMPORT = /\b(?:import|from)\s*\(?\s*["']([^"']+\.js)["']/g
  const urlOf = (file) => '/' + relative(DIST, file).split(sep).join('/')

  /** Resolve a relative specifier against the importing chunk's own URL directory. */
  const resolveSpecifier = (dir, spec) => {
    const out = dir.split('/').filter(Boolean)
    for (const part of spec.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') out.pop()
      else out.push(part)
    }
    return '/' + out.join('/')
  }

  const chunks = new Map()
  for (const file of jsFiles) {
    const url = urlOf(file)
    const buffer = await readFile(file)
    const body = buffer.toString('utf8')
    const dir = url.slice(0, url.lastIndexOf('/'))
    const imports = [...body.matchAll(IMPORT)].map(([, spec]) =>
      spec.startsWith('.') ? resolveSpecifier(dir, spec) : spec,
    )
    chunks.set(url, { file: relative(DIST, file), bytes: buffer.length, imports, body })
  }

  /**
   * On demand, not on load, and stated rather than left to luck.
   *
   * `search.ts` reaches `/pagefind/pagefind.js` through a dynamic `import()`
   * behind a user action: nothing under here is downloaded until a reader opens
   * the search modal, so charging it to page load would repeat the mistake
   * `750005b` fixed: billing one page for another's bytes.
   *
   * Written down because right now it also happens *by accident*: Rollup
   * minifies the specifier into a variable, so the `IMPORT` regex above never
   * sees the literal and never charges it. The day Rollup inlines that constant
   * instead, 45 KB would land on every page of the site with no explanation.
   * An exclusion that is a decision behaves the same on both of those days.
   *
   * The weight is reported instead, in the Search section below.
   */
  const ON_DEMAND = '/pagefind/'

  /** The chunks a page really downloads: the ones it names, plus their imports. */
  const closure = (entries) => {
    const seen = new Set()
    const queue = [...entries]
    while (queue.length > 0) {
      const url = queue.pop()
      // A specifier that resolves to nothing in `dist/` is not ours to explain:
      // a bare module name, or a string that only looked like a path.
      if (seen.has(url) || !chunks.has(url) || url.startsWith(ON_DEMAND)) continue
      seen.add(url)
      queue.push(...chunks.get(url).imports)
    }
    return seen
  }

  /**
   * What a page names. Astro emits a `<script src>` for a chunk the page needs
   * and *nothing at all* for a page that needs none, so this is the browser's
   * own answer rather than an approximation of it. `modulepreload` is read too:
   * Astro does not emit one here today, but a preloaded chunk is downloaded
   * just the same, and missing it would under-count.
   */
  const referencedBy = (html) =>
    [/<script\b[^>]*\bsrc="([^"]+\.js)"/g, /<link\b[^>]*\bhref="([^"]+\.js)"/g].flatMap((re) =>
      [...html.matchAll(re)].map((m) => m[1]),
    )

  /**
   * Budget per *page*, not across the site, and per page means *this* page.
   *
   * This used to total every `.js` in `dist/` and charge that total to all of
   * them, so 20 KB of `d3-force` was billed to the 404 page and every tag
   * index. That was defensible while the graph was the only client code
   * (over-charging is the safe direction), but it stopped being defensible once
   * a 1.2 KB feature's fate depended on a number that was mostly somebody
   * else's chunk. It also made "the worst page" useless as a diagnostic, which
   * is the part a budget is actually for.
   *
   * Fixing the metric deliberately does *not* move the ceiling, and the
   * headroom it appears to hand back is worth reading carefully. Most pages
   * drop by around 20 KB, but the page this budget actually asserts against is
   * whichever one loads the graph, and that page gains *nothing*: 23,205 of
   * 24,576 bytes, so 1,371 to spare. The 20 KB accrues to pages that were never
   * near the ceiling. Nothing was freed; something was only ever miscounted,
   * and the binding constraint is as tight as it was.
   */
  const perPage = pages.map(({ file, html }) => {
    const inline = [...html.matchAll(INLINE)].reduce((n, m) => n + Buffer.byteLength(m[1]), 0)
    const loaded = closure(referencedBy(html))
    const shared = [...loaded].reduce((n, url) => n + chunks.get(url).bytes, 0)
    return { file, bytes: inline + shared, loaded }
  })
  const worst = perPage.reduce((a, b) => (a.bytes >= b.bytes ? a : b), { file: '-', bytes: 0 })

  pass(
    'JavaScript per page',
    `${worst.bytes} bytes at worst (${worst.file}); ${scripts.length} inline block(s) site-wide`,
  )
  /**
   * 32 KB, raised from 24 KB when search shipped, and the raise is the
   * deliberate commit rather than the surprise.
   *
   * 24 KB was set against the one page that could reach it: a `panels` note
   * with the graph on, 23,205 bytes of 24,576 with 1,371 to spare. Search is
   * the second feature heavy enough to become a real chunk, and unlike the
   * graph it is mounted from `Base.astro`, so its 6,096 bytes land on *every*
   * page, and on a note page they land on top of the graph's 20,824. That page
   * measures 29,301 bytes, and no amount of tightening either island closes a
   * 4,725-byte gap.
   *
   * So the ceiling moves once, to the smallest round number above the real
   * worst case with comparable headroom: 32,768, leaving 3,467. It is still a
   * ceiling on **one page**, still counted per page, and turning a feature off
   * still removes its bytes entirely. What it is not any more is a claim that
   * every jotter site fits in 24 KB: that was true of a build with one island
   * and stopped being true of a build with two.
   *
   * Worth knowing while reading a number close to it: Astro inlines a script
   * chunk under **4096 bytes** into the page rather than emitting a `.js` file,
   * so a small island never becomes a shared chunk at all, and an island that
   * later crosses 4 KB flips to one, which is a discontinuous jump rather than
   * a gradual one.
   */
  check(worst.bytes < 32 * 1024, 'a page ships under 32 KB of JavaScript', `${worst.bytes} bytes on ${worst.file}`)

  /**
   * Attribution can hide what a total could not: a chunk that ships in `dist/`
   * and is charged to nobody because nothing references it. That is dead weight
   * a reader still pays to have deployed, and now that no page is billed for it
   * the budget would never notice.
   *
   * The counts are reported rather than asserted. The assertion with real teeth
   * is which *pages* may load which chunk: d3-force appearing on a tag index
   * would be a bug the byte total cannot name, because 20 KB on a 1 KB page is
   * still under budget. That needs a per-chunk allowlist, which is not worth
   * hardcoding against a single chunk; revisit when there are two.
   */
  const loadedBy = new Map([...chunks.keys()].map((url) => [url, 0]))
  for (const { loaded } of perPage) for (const url of loaded) loadedBy.set(url, loadedBy.get(url) + 1)

  const used = [...loadedBy].filter(([, n]) => n > 0)
  if (used.length > 0) {
    pass(
      'shared chunks',
      used
        .map(([url, n]) => `${chunks.get(url).file} ${chunks.get(url).bytes}B on ${n}/${pages.length} page(s)`)
        .join('; '),
    )
  }

  /**
   * Scoped to Astro's own output directory, and the scope is the whole point.
   *
   * `dist/` holds more `.js` than Rollup ever put there. `src/integrations/
   * vault.ts` copies *every* non-markdown file in the vault to `dist/_vault/`
   * with no extension allowlist, so a Templater or dataviewjs snippet living in
   * an Obsidian vault (or a code sample a note links to) lands in the build.
   * So does anything a user drops in `public/`. None of it is referenced by a
   * `<script src>`, all of it is perfectly correct, and failing over it would
   * be this check inventing a bug. Attribution still counts those files if a
   * page does reference one: they are real bytes, they are just not chunks.
   *
   * `_astro` is Astro's `build.assets` default, which jotter does not override.
   */
  const orphans = [...loadedBy]
    .filter(([url, n]) => n === 0 && url.startsWith('/_astro/'))
    .map(([url]) => chunks.get(url).file)
  check(orphans.length === 0, 'every chunk Astro emitted is referenced by a page', orphans.join(', '))

  /**
   * Nothing here should be reaching the network at runtime, and that has to
   * be asserted over the bundled files as well as the inline blocks. Until the
   * graph there were no `.js` files at all in `dist/`, so grepping inline
   * bodies covered everything; the moment client code moves into
   * `dist/_astro/*.js` an inline-only grep would police nothing and still pass.
   */
  const NETWORK = /\bfetch\(|XMLHttpRequest|new WebSocket|navigator\.sendBeacon|EventSource\(/

  /**
   * One exemption, by path, and it is named rather than a loosening.
   *
   * Pagefind *fetches*, and that is not an implementation detail: loading
   * index chunks over plain GETs as you type is the entire design, and what
   * makes a 1,000-note vault searchable without shipping one enormous file.
   * There is no embed-it-at-build-time way out here the way there was for
   * hover previews, and a fully embedded index would contradict the scale
   * target the `--full` pass asserts two sections down.
   *
   * So `dist/pagefind/**` is allowed and **everything jotter authors still
   * fails on `fetch(`**, which is the half with teeth, and the half that keeps
   * the hover-preview decision enforced rather than merely documented. Delete
   * the filter and this check fails; that is the test that it is doing
   * anything.
   */
  const authoredCode = (s) => !s.file.startsWith(`pagefind${sep}`)
  const fetches = [...scripts, ...chunks.values()].filter((s) => authoredCode(s) && NETWORK.test(s.body))
  check(
    fetches.length === 0,
    'no runtime network requests from code jotter wrote',
    fetches.map((s) => s.file).join(', '),
  )

  /**
   * What this check does *not* cover, now that it is not the only one standing
   * behind the README's privacy claims: a `<script src>` pointing somewhere
   * else. An external tag has no body for `NETWORK` to read and is not a file
   * in `dist/` for the chunk walk to find, so it is invisible here, and it was
   * invisible here for as long as this was the only network assertion jotter
   * had. That ground now belongs to `section('Third-party origins')` below,
   * which asserts the *set* of origins a page talks to.
   *
   * This check keeps the narrower half, which is also the half nobody else can
   * keep: no code jotter wrote opens a connection. It says nothing about what a
   * vendor's script does once it is running, and it should not pretend to.
   */
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
 * Written as a function rather than inline, because `--full` re-runs every one
 * of these against a second build with analytics forced on. On the committed
 * config the set of origins is empty and every check below is vacuously true,
 * so without that second pass, deleting this whole section would change
 * nothing, and an assertion that cannot fail is not an assertion.
 */
function thirdPartyOrigins(pages) {
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

section('Third-party origins')
thirdPartyOrigins(pages)

/* ------------------------------------------------------------------ search */

section('Search')
{
  const indexDir = join(DIST, 'pagefind')
  const built = await stat(indexDir).catch(() => null)

  if (!built) {
    pass('no search index in dist/', 'features.search is off')
  } else {
    /**
     * A cheap guard on `writePlayground` ever flipping. Pagefind's playground
     * is an HTML page under `/pagefind/playground/`, and the Markup section
     * above walks *every* `.html` in `dist/`, so it would fail the skip-link,
     * `<main>`, `lang` and `<title>` assertions all at once, from a file
     * nobody in this repo wrote.
     */
    const html = await walk(indexDir, (n) => n.endsWith('.html'))
    check(html.length === 0, 'the search index ships no HTML page', html.map((f) => relative(DIST, f)).join(', '))

    /**
     * Parsed, not merely present, and every file non-empty.
     *
     * A build was once seen where `pagefind-entry.json` and `pagefind.js` came
     * out 0 bytes: the files existed, so a stat-only check would have passed
     * while the shipped site loaded a search box that found nothing.
     * `src/integrations/search.ts` fails the build on this too; this is the
     * backstop that catches an index which reached `dist/` some other way.
     */
    const entry = await readFile(join(indexDir, 'pagefind-entry.json'), 'utf8').catch(() => null)
    let pageCount = 0
    try {
      pageCount = Object.values(JSON.parse(entry ?? '').languages).reduce((n, l) => n + l.page_count, 0)
    } catch {
      pageCount = 0
    }
    check(pageCount > 0, 'the search index entry file parses and names some pages', String(entry).slice(0, 80))

    const indexFiles = await walk(indexDir, () => true)
    const emptyFiles = []
    for (const file of indexFiles) if ((await stat(file)).size === 0) emptyFiles.push(relative(DIST, file))
    check(emptyFiles.length === 0, 'no file in the search index is empty', emptyFiles.join(', '))

    const indexed = authored.filter(({ html }) => html.includes('data-pagefind-body'))
    check(indexed.length > 0, 'at least one page is marked as indexable')

    /**
     * The listing pages are deliberately out of the index: their content is
     * note titles and excerpts already indexed on the notes themselves, so
     * indexing them would return the same note twice under a URL that is not
     * its own. `data-pagefind-body` is site-wide sticky, so this is what
     * enforces it: one stray attribute on a listing template and the whole
     * decision quietly reverses.
     *
     * Asked of the attribute's *position*, not the page's path. This used to
     * read `^(?:notes|tags)/`, which is a guess at which routes are listings
     * and is wrong the moment a vault has a folder called `notes`, a normal
     * thing to call a folder. It failed a real deploy over `notes/000-notes`
     * and `notes/999-openai-o1-models`, two ordinary note pages that were
     * correctly indexed. `src/layouts/Note.astro` is the only template that
     * emits the attribute, on its own `<article class="note-layout">`, so
     * "somewhere else" is exactly the regression this was ever guarding
     * against, and a folder name cannot look like one.
     */
    const strays = []
    for (const { file, html } of indexed) {
      for (const [tag] of html.matchAll(/<[a-z][^>]*\bdata-pagefind-body\b[^>]*>/gi)) {
        if (!/^<article\b/i.test(tag) || !/\bclass="note-layout"/.test(tag)) {
          strays.push(`${file}: ${tag.slice(0, 90)}`)
        }
      }
    }
    check(
      strays.length === 0,
      'nothing but a note is marked as indexable',
      strays.join('\n        '),
    )

    /**
     * Reported, not asserted, because it is the number the byte budget
     * deliberately does not charge to a page: none of it is downloaded until a
     * reader opens the modal. Reporting it is what keeps that exclusion honest:
     * the weight is visible, it is just billed to the right event.
     *
     * `pagefind-ui` and friends are pruned by `src/integrations/search.ts`;
     * this is what is left, so a jump here means either the vault grew or
     * Pagefind started writing something new.
     */
    const bytes = (await Promise.all(indexFiles.map(async (f) => (await stat(f)).size))).reduce((a, b) => a + b, 0)
    pass(
      'search index, downloaded on demand',
      `${Math.round(bytes / 1024)} KB across ${indexFiles.length} file(s) for ${pageCount} note(s); no page loads any of it`,
    )

    const vendorUi = indexFiles.filter((f) => /pagefind-(?:component-)?(?:modular-)?ui\.|pagefind-highlight\./.test(f))
    check(vendorUi.length === 0, 'Pagefind’s own unused UI bundles were pruned', vendorUi.map((f) => relative(DIST, f)).join(', '))
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
const ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/

function xmlWellFormed(xml) {
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
 * would change nothing. `--full` rebuilds with the feed on and runs it again
 * against real output, which is what gives it teeth.
 *
 * `MAX_ITEMS` is duplicated from `src/lib/feed.ts` rather than imported: this
 * is a `.mjs` script and that is a TypeScript module. Kept as a named constant
 * so a change there fails here loudly rather than widening the assertion.
 */
const FEED_MAX_ITEMS = 50

async function feedSection(pages) {
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

section('Feed')
await feedSection(pages)

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
 * which is the half that bites here. `--full` re-runs it against the rss-on
 * rebuild, which already sets `url` and additionally sets `config.image`.
 */
async function socialCards(pages) {
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

section('Social cards')
await socialCards(pages)

/* ------------------------------------------------------------ full mode */

const spawned = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'pipe', ...options })
    let out = ''
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('exit', (code) => resolve({ code, out }))
  })

const run = (args, options = {}) => spawned('npx', args, options)

/** The Open Publish scripts, which are plain Node rather than a bin on PATH. */
const runNode = (args, options = {}) => spawned(process.execPath, args, options)

/**
 * `--full` rebuilds twice, and both rebuilds clear the content-collection
 * stores: the rewritten `jotter.config.ts` below changes the markdown pipeline
 * without changing a single source digest, which is the one thing the content
 * layer does not notice. See `lib/astro-cache.mjs`.
 *
 * Neither the config rewrite nor the clearing is survivable by a dev server
 * reading the same files, so it refuses for the same reason `npm run clean`
 * does.
 */
if (FULL) {
  const servers = runningDevServers(ROOT)
  if (servers.length > 0) {
    console.error(`\n${devServerWarning(servers, 'npm run verify:full')}`)
    process.exit(1)
  }

  section('Feature flags off means no JavaScript')
  {
    const configPath = join(ROOT, 'jotter.config.ts')
    const original = await readFile(configPath, 'utf8')
    /**
     * `nav` goes off alongside the feature flags because the drawer
     * enhancement is gated on it rather than on `features`. It is the one
     * script that is not a feature, so leaving `nav: 'tree'` here would assert
     * "no JavaScript" against a page that legitimately ships some.
     */
    const off = original
      .replace(
        /features:\s*\{[\s\S]*?\}/,
        `features: { toc: true, backlinks: true, tags: false, themeToggle: false, metadata: false, prevNext: true, graph: false, search: false, hoverPreview: false, rss: false, embeds: false }`,
      )
      .replace(/\bnav:\s*'(?:tree|tags|none)'/, `nav: 'none'`)
      /**
       * `analytics` is a *sibling* of `features`, so the rewrite above could
       * never reach it: a forker with a provider configured would fail the "no
       * JavaScript at all" check below through no fault of their own, and the
       * detail line would send them hunting for an inline script that does not
       * exist. A no-op on the committed config, which has no analytics key.
       *
       * The `provider:` token rather than an `analytics:\s*\{[^}]*\}` block:
       * the block form stops at the first `}`, so a comment or a nested value
       * inside the object would produce a syntax error, and a syntax error
       * here surfaces as `fail('build succeeds with features off')`, a failure
       * whose real cause is this rewrite. `features` gets away with the block
       * form only because its schema forbids nesting.
       */
      .replace(/\bprovider:\s*'[a-z]+'/, `provider: 'none'`)

    /**
     * Every rewrite above is a regex against a file the forker owns and may
     * have formatted any way they like. Unchecked, a miss is silent: the
     * assertions then run against a build with the feature still *on*, and pass
     * or fail for reasons that have nothing to do with what they claim to test.
     */
    const unrewritten = [
      [/\bthemeToggle:\s*false/, 'features.themeToggle'],
      [/\bsearch:\s*false/, 'features.search'],
      [/\brss:\s*false/, 'features.rss'],
      // `embeds` is the one scripted feature that defaults *on*, so a rewrite
      // that missed it would leave the click-to-play island in a build this
      // section asserts ships no JavaScript at all.
      [/\bembeds:\s*false/, 'features.embeds'],
      [/\bnav:\s*'none'/, 'nav'],
      ...(/\bprovider:/.test(original) ? [[/\bprovider:\s*'none'/, 'analytics.provider']] : []),
    ]
      .filter(([re]) => !re.test(off))
      .map(([, name]) => name)
    check(unrewritten.length === 0, 'the config rewrite reached every key it needed to', unrewritten.join(', '))

    await writeFile(configPath, off)
    await clearContentStores(ROOT)

    const { code, out } = await run(['astro', 'build'])
    if (code !== 0) {
      fail('build succeeds with features off', out.slice(-800))
    } else {
      const offPages = await Promise.all(
        (await walk(DIST, (n) => n.endsWith('.html'))).map((f) => readFile(f, 'utf8')),
      )
      const offJs = await walk(DIST, (n) => n.endsWith('.js'))
      const inline = offPages.flatMap((html) => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)])
      const themeCode = offPages.filter((html) => html.includes('jotter-theme'))
      const tagChips = offPages.filter((html) => html.includes('tag-chip'))

      const previewAttrs = offPages.filter((html) => html.includes('data-preview'))
      const searchAttrs = offPages.filter((html) => html.includes('data-pagefind-body'))
      const searchIndex = await stat(join(DIST, 'pagefind')).catch(() => null)

      check(themeCode.length === 0, 'themeToggle off removes its inline script entirely')
      check(tagChips.length === 0, 'tags off removes every tag chip')
      /**
       * The markup half of the guarantee the no-JavaScript check makes below.
       * With `hoverPreview` off the excerpts are *absent* from the anchors, not
       * merely unread: the flag decides whether the bytes are emitted at all.
       */
      check(previewAttrs.length === 0, 'hoverPreview off emits no data-preview attribute')
      /**
       * The same guarantee, both halves. With `search` off the integration is
       * never registered (so there is no index directory) *and* the markup
       * that would have been indexed is unmarked, rather than marked and
       * unused.
       */
      check(searchIndex === null, 'search off writes no dist/pagefind/')
      check(searchAttrs.length === 0, 'search off emits no data-pagefind-body attribute')
      /**
       * The only place `provider: 'none'` emitting nothing is asserted against
       * a real build: the main pass above cannot check it for a forker who
       * does have a provider configured. The analytics counterpart of `search
       * off writes no dist/pagefind/`.
       */
      const offExternal = offPages.filter((html) => /<script\b[^>]*\bsrc="(?:https?:)?\/\//.test(html))
      check(offExternal.length === 0, 'analytics off loads no third-party script', `${offExternal.length} page(s)`)

      /**
       * Counted apart, because an external tag has an empty body and would
       * otherwise be reported as an "inline block", which is a true statement
       * about the regex and a misleading one about the page.
       */
      const externalTags = inline.filter((m) => /\bsrc=/.test(m[0]))
      check(
        inline.length === 0 && offJs.length === 0,
        'no JavaScript at all when every scripted feature and the nav are off',
        `${inline.length - externalTags.length} inline block(s), ${externalTags.length} external tag(s), ${offJs.length} file(s)`,
      )
    }

    await writeFile(configPath, original)
    await clearContentStores(ROOT)
  }

  /**
   * The second config rewrite, and the one that gives `section('Third-party
   * origins')` something to bite.
   *
   * On the committed config no provider is set, so every origin check up there
   * is vacuously true and deleting the section outright would change nothing.
   * The alternative (turning analytics *on* in the committed
   * `jotter.config.ts` the way `graph` and `search` are on) is the wrong way
   * to fix that: it is the one flag whose on state has an effect outside this
   * repo, and it would send real hits to a real vendor from anyone who runs
   * `npm run build`, which would make the README's "no tracking" false of the
   * very build it describes. A throwaway rebuild costs one `astro build` and
   * touches nobody.
   */
  section('Analytics on emits exactly one vendor tag')
  {
    const configPath = join(ROOT, 'jotter.config.ts')
    const original = await readFile(configPath, 'utf8')

    const ANALYTICS_ON = `analytics: { provider: 'plausible', id: 'example.com' }`
    /**
     * `[^{}]*` rather than a lazy `[\s\S]*?`: the analytics object has no
     * nested object in its schema, so this cannot run past its own closing
     * brace, and a config it fails to match is caught by the guard below rather
     * than rewritten into a syntax error.
     */
    const on = /\banalytics:\s*\{/.test(original)
      ? original.replace(/\banalytics:\s*\{[^{}]*\}/, ANALYTICS_ON)
      : original.replace(/\n\}\)\s*;?\s*$/, `\n  ${ANALYTICS_ON},\n})\n`)

    if (!/provider:\s*'plausible'/.test(on)) {
      fail('the analytics-on rewrite reached jotter.config.ts', 'no analytics key was written; the checks below would be vacuous')
    } else {
      await writeFile(configPath, on)
      await clearContentStores(ROOT)

      const { code, out } = await run(['astro', 'build'])
      if (code !== 0) {
        fail('build succeeds with analytics on', out.slice(-800))
      } else {
        const files = await walk(DIST, (n) => n.endsWith('.html'))
        const onPages = await Promise.all(
          files.map(async (file) => ({ file: relative(DIST, file), html: await readFile(file, 'utf8') })),
        )
        thirdPartyOrigins(onPages)
      }

      await writeFile(configPath, original)
      await clearContentStores(ROOT)
    }
  }

  /**
   * The third config rewrite, and the one that gives `section('Feed')`
   * something to bite.
   *
   * On the committed config `url` is commented out, so `features.rss` cannot
   * even be turned on (the schema refuses the pair), and every check in that
   * section is vacuously true. Turning the feed on in the committed
   * `jotter.config.ts` is the wrong way to fix that for the same reason
   * analytics is left off: `url` is a claim about where the site lives, and a
   * demo build that asserts `https://example.com` into its own canonical links
   * and sitemap is a demo build lying about itself. A throwaway rebuild costs
   * one `astro build` and touches nobody.
   *
   * `url` is the third top-level key these rewrites reach, and the first that
   * is *commented out* rather than set, so turning the feed on means
   * uncommenting a line, not replacing a value.
   */
  /**
   * `export default defineConfig({`, not `defineConfig({`. The docstring at the
   * top of `jotter.config.ts` contains the words *`defineConfig({})` builds a
   * working site*, so the shorter anchor matches a **comment** first, and a
   * non-global `replace` would insert the key there and nowhere else. Caught by
   * the `unrewritten` guards rather than shipped, but a guard firing on a
   * config nobody mistyped is a guard nobody trusts.
   */
  const CALL = /export default defineConfig\(\{/

  /**
   * Turn the feed on in a config source: `url`, which the schema requires
   * before `features.rss` is even allowed, and the flag itself.
   *
   * Shared by two rebuilds: the RSS section below, and the homepage one after
   * it, which needs a feed in order to assert that the note claiming `/` is
   * linked as `/` in the feed too. That is the exact place the removed
   * `homepageSlug` option used to paper over.
   *
   * Three cases each: `url` is *commented out* in the committed config rather
   * than set, and `features` is not a key every config has: the README
   * documents `defineConfig({})` as a complete config, and one written that way
   * has no `features:` block to insert `rss` into.
   */
  const withFeedOn = (source) => {
    let on = source
    if (/^\s*url:\s*'/m.test(on)) {
      // Already set: a forker's own URL is better than ours, and leaving it
      // means the origin assertions run against what they actually ship.
    } else if (/^\s*\/\/\s*url:\s*'/m.test(on)) {
      on = on.replace(/^(\s*)\/\/\s*(url:\s*'[^']*',)/m, '$1$2')
    } else {
      on = on.replace(CALL, `export default defineConfig({\n  url: 'https://example.com',`)
    }

    if (/\brss:\s*(?:true|false)/.test(on)) {
      on = on.replace(/\brss:\s*(?:true|false)/, 'rss: true')
    } else if (/\bfeatures:\s*\{/.test(on)) {
      on = on.replace(/\bfeatures:\s*\{/, 'features: {\n    rss: true,')
    } else {
      on = on.replace(CALL, `export default defineConfig({\n  features: { rss: true },`)
    }
    return on
  }

  /** What `withFeedOn` must have reached, for either section's guard. */
  const FEED_ON_KEYS = [
    [/^\s*url:\s*'https?:\/\//m, 'url'],
    [/\brss:\s*true/, 'features.rss'],
  ]

  /** The origin `withFeedOn` writes, and so what the feed's own links carry. */
  const FEED_ORIGIN = 'https://example.com'

  /**
   * The site-wide card image, set on the same rebuild rather than on a fifth
   * one: `section('Social cards')` needs exactly one condition the committed
   * config does not have (a `url` to make an `og:image` absolute), and this
   * section already establishes it.
   *
   * Somebody else's host on purpose. The demo vault has one raster attachment
   * and `Kitchen sink.md` already claims it in frontmatter, so a site-wide
   * default resolved from the vault would be the *same* URL and the precedence
   * assertion would pass for no reason. A remote URL keeps the two apart, and
   * exercises the pass-through case at the same time: an `og:image` is a
   * declaration rather than a subresource, so no origin check is affected.
   */
  const SITE_IMAGE = 'https://cdn.example.com/og.png'
  const withSocialImage = (source) =>
    /^\s*image:\s*'/m.test(source)
      ? source // A forker's own is better than ours, and gets checked instead.
      : source.replace(CALL, `export default defineConfig({\n  image: '${SITE_IMAGE}',`)

  section('RSS on emits a feed every page advertises')
  {
    const configPath = join(ROOT, 'jotter.config.ts')
    const original = await readFile(configPath, 'utf8')

    const on = withSocialImage(withFeedOn(original))

    /**
     * The `unrewritten` guard, extended to a fourth key. It exists precisely so
     * a regex that misses fails loudly instead of running the feed assertions
     * against a build with no feed in it, where every one of them would pass
     * for the wrong reason.
     */
    const unrewritten = [...FEED_ON_KEYS, [/^\s*image:\s*'/m, 'image']]
      .filter(([re]) => !re.test(on))
      .map(([, name]) => name)

    if (unrewritten.length > 0) {
      fail('the rss-on rewrite reached every key it needed to', `${unrewritten.join(', ')}; the checks below would be vacuous`)
    } else {
      await writeFile(configPath, on)
      await clearContentStores(ROOT)

      const { code, out } = await run(['astro', 'build'])
      if (code !== 0) {
        fail('build succeeds with rss on', out.slice(-800))
      } else {
        const files = await walk(DIST, (n) => n.endsWith('.html'))
        const onPages = await Promise.all(
          files.map(async (file) => ({ file: relative(DIST, file), html: await readFile(file, 'utf8') })),
        )
        await feedSection(onPages)
        /**
         * The other half of what this rebuild's `url` buys, and the only pass
         * where `section('Social cards')` above has anything to bite.
         */
        await socialCards(onPages)

        /**
         * The publish gate again, against the build that has a feed in it. The
         * widened corpus above is what makes this reach `rss.xml` at all, and
         * this is the only pass where there is one to reach.
         */
        const onOutputs = await Promise.all(
          (await walk(DIST, (n) => TEXT_OUTPUT.test(n) || n === '_redirects')).map(async (file) => ({
            file: relative(DIST, file),
            text: await readFile(file, 'utf8'),
          })),
        )
        const leaked = onOutputs.filter(({ text }) => text.includes('A title that must never reach the site'))
        check(
          leaked.length === 0,
          'no unpublished note’s title reaches the feed either',
          leaked.map((p) => p.file).join(', '),
        )
      }

      await writeFile(configPath, original)
      await clearContentStores(ROOT)
    }
  }

  /**
   * The fourth config rewrite, and the one that gives `internalLinks()`
   * something homepage-shaped to bite.
   *
   * On the committed config `homepage` is unset, so `/` is a root `index.md`
   * and the entire promotion path is unexercised: a named note served at `/`
   * and nowhere else, `[...slug].astro` skipping it, every link to it spelled
   * `/`, the 301 from the URL it used to have, and a root `index.md` displaced
   * rather than dropped. Setting `homepage:` in the committed config is the
   * wrong way to fix that: `index.md` is the front door the demo garden
   * documents and the shape a forker starts from, and this is the one config
   * key whose whole purpose is to *change* that. A throwaway rebuild costs one
   * `astro build`.
   *
   * `Zettelkasten` rather than any other note because the demo vault also has a
   * root `index.md`, so this rebuild exercises the collision (two notes
   * claiming `/`) rather than the easy case.
   */
  section('A note claiming / is served there, and only there')
  {
    const configPath = join(ROOT, 'jotter.config.ts')
    const original = await readFile(configPath, 'utf8')

    const CLAIMANT = 'Zettelkasten'
    const VACATED = '/zettelkasten'
    const named = /^\s*homepage:/m.test(original)
      ? original.replace(/^(\s*)homepage:.*$/m, `$1homepage: '${CLAIMANT}',`)
      : original.replace(CALL, `export default defineConfig({\n  homepage: '${CLAIMANT}',`)

    /**
     * With the feed on as well, because the feed is where the note claiming `/`
     * used to be special-cased: `feedXml` took a `homepageSlug` to steer its
     * item to the root, and that option is gone. Nothing but a build with both
     * keys set can show that it is not missed.
     */
    const on = withFeedOn(named)

    /**
     * The `unrewritten` guard again, for a fourth key alongside the feed's two.
     * Without it a regex that misses runs every assertion below against a build
     * with no homepage in it, where they pass for reasons that have nothing to
     * do with what they claim to test.
     */
    const unrewritten = [
      [new RegExp(`homepage:\\s*'${CLAIMANT}'`), 'homepage'],
      ...FEED_ON_KEYS,
    ]
      .filter(([re]) => !re.test(on))
      .map(([, name]) => name)

    if (unrewritten.length > 0) {
      fail(
        'the homepage rewrite reached every key it needed to',
        `${unrewritten.join(', ')}; the checks below would be vacuous`,
      )
    } else {
      await writeFile(configPath, on)
      await clearContentStores(ROOT)

      const { code, out } = await run(['astro', 'build'])
      if (code !== 0) {
        fail('build succeeds with a homepage set', out.slice(-800))
      } else {
        const onPages = await Promise.all(
          (await walk(DIST, (n) => n.endsWith('.html'))).map(async (file) => ({
            file: relative(DIST, file),
            html: await readFile(file, 'utf8'),
          })),
        )
        const home = onPages.find((p) => p.file === 'index.html')?.html ?? ''

        check(
          home.includes(`<h1 class="note-title">${CLAIMANT}</h1>`),
          '/ renders the note homepage names',
        )
        check(
          (await stat(join(DIST, CLAIMANT.toLowerCase())).catch(() => null)) === null,
          `and gets no second page at ${VACATED}`,
          'the same note at two URLs is two sitemap entries and two search results',
        )

        /**
         * The bug this section exists for. Every `noteHref` call site kept
         * emitting the old slug while nothing served it, and `internalLinks()`
         * alone would not catch the regression coming back, because the 301
         * below makes those links *resolve*. Working links to the wrong URL are
         * still the wrong URL.
         *
         * Over every text output rather than the pages, so it reads the feed
         * and the sitemap too: those are the two that carry a note's URL
         * without being a page, and the feed is where the note claiming `/`
         * used to need an option of its own. `_redirects` and `vercel.json`
         * are the one exemption: the old slug appears there on purpose, as
         * the redirect's *source*.
         */
        const REDIRECT_FILES = new Set(['_redirects', 'vercel.json'])
        /**
         * A whole URL, never a substring. The demo vault tags this very note
         * `method/zettelkasten`, so `/tags/method/zettelkasten` carries these
         * characters on every page that shows the tag and in every output that
         * lists it. Anchored on the two ways a URL is written here (an `href`
         * attribute and an absolute URL inside XML), and ended on the
         * delimiters a path can actually end at.
         */
        const STALE = new RegExp(
          `(?:href="|${FEED_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})` +
            `${VACATED}(?=["#?<]|$)`,
        )
        const onOutputs = await Promise.all(
          (await walk(DIST, (n) => TEXT_OUTPUT.test(n) || n === '_redirects')).map(async (file) => ({
            file: relative(DIST, file),
            text: await readFile(file, 'utf8'),
          })),
        )
        const stale = onOutputs.filter(
          ({ file, text }) =>
            !file.startsWith(`_vault${sep}`) && !REDIRECT_FILES.has(file) && STALE.test(text),
        )
        check(
          stale.length === 0,
          'nothing in dist/ still points at the slug it used to have',
          stale.map((p) => p.file).join(', '),
        )

        const netlify = await readFile(join(DIST, '_redirects'), 'utf8').catch(() => '')
        /**
         * A 302, and the status is half the assertion. This rule is recomputed
         * from `homepage:` on every build, so unsetting that key withdraws it
         * and points the plugin's recorded move the other way. A 301 here is a
         * promise a browser keeps after the build stops making it, and the two
         * halves together are `ERR_TOO_MANY_REDIRECTS`. See `RedirectRule`.
         */
        check(
          netlify.includes(`${VACATED} / 302`),
          `${VACATED} still works, as a 302 to /`,
          netlify.trim().split('\n').join(' | '),
        )

        /**
         * The feed's half of it, stated positively: an item (a `<guid>` is
         * item-only, unlike `<link>`, which the channel also carries) points
         * at the site root. With `feedSection` below, this is the whole of what
         * `homepageSlug` used to buy, now bought by the `index` slug instead.
         */
        const rss = await readFile(join(DIST, 'rss.xml'), 'utf8').catch(() => '')
        check(
          rss.includes(`<guid isPermaLink="true">${FEED_ORIGIN}/</guid>`),
          'the feed links the note claiming / to the site root',
        )

        /**
         * The collision. The demo vault has a root `index.md` as well, config
         * wins, and the displaced note keeps a page: a note that vanished from
         * the site while every listing, the nav tree, the graph and the feed
         * still named it would be the worse failure.
         */
        const displaced = onPages.find((p) => p.file === 'index-2.html')
        check(displaced !== undefined, 'the displaced index.md keeps a page of its own')
        check(
          out.includes('claim "/"') && out.includes('index.md') && out.includes(CLAIMANT),
          'the build warns about the collision, naming both files',
        )

        await internalLinks(onPages)
        await redirectsAndRobots()
        await feedSection(onPages)
      }

      await writeFile(configPath, original)
      await clearContentStores(ROOT)
    }
  }

  /**
   * The fifth config rewrite, and the one both URL features live or die on.
   *
   * `slugs:` and `permalink:` exist for a vault whose addresses are already in
   * other people's bookmarks, and neither is exercised by the committed config
   * by design: the default is `derive`, and it has to stay that way or every
   * jotter site built so far moves. Turning them on in `jotter.config.ts` would
   * be the wrong fix twice over: the demo garden documents the default, and a
   * forker reading it would inherit a scheme they did not choose.
   *
   * So this builds a synthetic vault instead, through the same
   * `JOTTER_VAULT_OVERRIDE` harness `section('Scale')` uses, holding the five
   * paths that exercise the modes plus one note carrying a `permalink:`. One
   * rebuild covers both features and all four URL producers.
   */
  section('URLs jotter is told, not URLs jotter invents')
  {
    const configPath = join(ROOT, 'jotter.config.ts')
    const original = await readFile(configPath, 'utf8')

    const URLS = join(tmpdir(), `jotter-urls-${process.pid}`)

    /**
     * `[vault path, slug, the URL it must be served at]`, under
     * `slugs: 'obsidian'`.
     *
     * The slug is what lands in `dist/`; the URL is what every link, the
     * canonical, the sitemap and a search result must spell. They differ by
     * exactly one thing (percent-encoding), and the third row is where that
     * stops being theoretical.
     */
    const ROWS = [
      ['notes/plain.md', 'notes/plain', '/notes/plain'],
      ['Projects/Q3 Plan.md', 'Projects/Q3+Plan', '/Projects/Q3+Plan'],
      [
        'Wisdom & Approaches/Critical Thinking.md',
        'Wisdom+&+Approaches/Critical+Thinking',
        '/Wisdom+%26+Approaches/Critical+Thinking',
      ],
      [
        'یادداشت‌ها/تفکر نقاد.md',
        'یادداشت‌ها/تفکر+نقاد',
        `/${encodePath('یادداشت‌ها/تفکر+نقاد')}`,
      ],
      ['index.md', 'index', '/'],
    ]

    /** The note that keeps an address its path would never derive. */
    const PERMALINK = { path: 'Legacy Note.md', slug: 'Company/About+us', vacated: '/Legacy+Note' }

    const body = (title) =>
      `---\ntitle: ${title}\n---\n\n# ${title}\n\nA note in the URL fixture vault.\n`

    await rm(URLS, { recursive: true, force: true })
    for (const [path, , url] of ROWS) {
      await mkdir(join(URLS, ...path.split('/').slice(0, -1)), { recursive: true })
      await writeFile(
        join(URLS, ...path.split('/')),
        path === 'index.md'
          ? `---\ntitle: Home\n---\n\n# Home\n\nEvery note: ` +
              ROWS.filter(([p]) => p !== 'index.md')
                .map(([p]) => `[[${p.split('/').pop().replace(/\.md$/, '')}]]`)
                .join(', ') +
              `, [[Legacy Note]].\n`
          : body(path.split('/').pop().replace(/\.md$/, '')) + `\nServed at \`${url}\`.\n`,
      )
    }
    await writeFile(
      join(URLS, PERMALINK.path),
      `---\ntitle: Legacy\npermalink: ${PERMALINK.slug}\n---\n\n# Legacy\n\n` +
        `An address this note kept.\n`,
    )

    const withSlugs = (source) =>
      /^\s*slugs:\s*'/m.test(source)
        ? source.replace(/^(\s*)slugs:\s*'[^']*',?$/m, `$1slugs: 'obsidian',`)
        : source.replace(CALL, `export default defineConfig({\n  slugs: 'obsidian',`)

    /** Search on, so the fourth producer exists to be compared. */
    const withSearchOn = (source) => {
      if (/\bsearch:\s*(?:true|false)/.test(source)) {
        return source.replace(/\bsearch:\s*(?:true|false)/, 'search: true')
      }
      if (/\bfeatures:\s*\{/.test(source)) {
        return source.replace(/\bfeatures:\s*\{/, 'features: {\n    search: true,')
      }
      return source.replace(CALL, `export default defineConfig({\n  features: { search: true },`)
    }

    const on = withSearchOn(withSlugs(withFeedOn(original)))

    const unrewritten = [
      [/^\s*slugs:\s*'obsidian'/m, 'slugs'],
      [/\bsearch:\s*true/, 'features.search'],
      ...FEED_ON_KEYS,
    ]
      .filter(([re]) => !re.test(on))
      .map(([, name]) => name)

    if (unrewritten.length > 0) {
      fail(
        'the URL rewrite reached every key it needed to',
        `${unrewritten.join(', ')}; the checks below would be vacuous`,
      )
    } else {
      await writeFile(configPath, on)
      await clearContentStores(ROOT)

      const { code, out } = await run(['astro', 'build'], {
        env: { ...process.env, JOTTER_VAULT_OVERRIDE: URLS },
      })

      if (code !== 0) {
        fail('build succeeds with slugs and a permalink set', out.slice(-800))
      } else {
        const onPages = await Promise.all(
          (await walk(DIST, (n) => n.endsWith('.html'))).map(async (file) => ({
            file: relative(DIST, file),
            html: await readFile(file, 'utf8'),
          })),
        )
        const textOut = await walk(DIST, (n) => TEXT_OUTPUT.test(n) || n === '_redirects')
        const onOutputs = await Promise.all(
          textOut.map(async (file) => ({
            file: relative(DIST, file),
            text: await readFile(file, 'utf8'),
          })),
        )

        /** Every row: the page is on disk at the slug, and the URL decodes to it. */
        const everyRow = [...ROWS, [PERMALINK.path, PERMALINK.slug, `/${PERMALINK.slug}`]]
        for (const [path, slug, url] of everyRow) {
          const page = pageFileFor(slug)
          check(
            (await stat(page).catch(() => null)) !== null,
            `${path} is served at ${url}`,
            `no page at ${relative(DIST, page)}`,
          )
          check(
            decodePath(url) === (slug === 'index' ? '/' : `/${slug}`),
            `and ${url} percent-decodes to the slug it is stored under`,
            `${decodePath(url)} != /${slug}`,
          )
        }

        /**
         * The permalink half, stated the way `section('A note claiming /')`
         * states the homepage's: served where it was told, 301 from the URL its
         * path derives, and that derived URL appearing **nowhere else**. A
         * working link to the wrong URL is still the wrong URL.
         */
        const netlify = onOutputs.find((o) => o.file === '_redirects')?.text ?? ''
        /**
         * A 302 for the same reason the homepage's is: delete the `permalink:`
         * and this rule reverses. It is the exact pair that produced the
         * intermittent redirect loop on a real deploy.
         */
        check(
          netlify.includes(`${PERMALINK.vacated} /${PERMALINK.slug} 302`),
          `${PERMALINK.vacated} still works, as a 302 to /${PERMALINK.slug}`,
          netlify.trim().split('\n').join(' | '),
        )

        const REDIRECT_FILES = new Set(['_redirects', 'vercel.json'])
        const spelled = (path) =>
          new RegExp(
            `(?:href="|${FEED_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})` +
              `${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=["#?<]|$)`,
          )
        const stale = onOutputs.filter(
          ({ file, text }) =>
            !file.startsWith(`_vault${sep}`) &&
            !REDIRECT_FILES.has(file) &&
            spelled(PERMALINK.vacated).test(text),
        )
        check(
          stale.length === 0,
          'nothing in dist/ still points at the slug the permalink replaced',
          stale.map((p) => p.file).join(', '),
        )

        /**
         * The Quartz failure, asserted against rather than described.
         * `slugifyFilePath` maps `&` to `-and-` and `%` to `-percent`, and
         * `sluggify` lowercases nothing but jotter's own `derive` does, so
         * these three strings are exactly what "the slug scheme leaked" looks
         * like. Restricted to URL-shaped occurrences, because `-and-` is also
         * what a heading called "Emphasis and marks" anchors as, and that is
         * prose rather than a slug.
         */
        const URL_IN = /(?:href="|<loc>)([^"<]*)/g
        const lowercased = [...ROWS, [PERMALINK.path, PERMALINK.slug]]
          .map(([, slug]) => slug)
          .filter((slug) => slug !== slug.toLowerCase())
          .map((slug) => `/${encodePath(slug.toLowerCase())}`)
        const leaked = []
        for (const { file, text } of onOutputs) {
          if (file.startsWith(`_vault${sep}`) || REDIRECT_FILES.has(file)) continue
          for (const [, url] of text.matchAll(URL_IN)) {
            if (!url.startsWith('/') && !url.startsWith(FEED_ORIGIN)) continue
            const path = url.replace(FEED_ORIGIN, '').split('#')[0]
            if (/-and-|-percent/.test(path)) leaked.push(`${file}: ${url}`)
            if (lowercased.includes(path)) leaked.push(`${file}: ${url}`)
          }
        }
        check(
          leaked.length === 0,
          'no URL in dist/ was slugified, lowercased or substituted',
          leaked.slice(0, 8).join('\n        '),
        )
        check(lowercased.length > 0, 'the fixture actually has mixed-case slugs to protect')

        /** Degrade loudly: the one host that cannot serve these URLs is named. */
        check(
          out.includes('Netlify') && out.includes('uppercase'),
          'the build says which host lowercases these paths',
        )

        await internalLinks(onPages)
        await producersAgree(onPages)
        await redirectsAndRobots()
      }

      await rm(URLS, { recursive: true, force: true })
      await writeFile(configPath, original)
      await clearContentStores(ROOT)
    }
  }

  /**
   * The sixth rebuild, and the only one whose config is not rewritten but
   * *generated*: `scripts/fetch-content.mjs` writes `jotter.config.ts` from the
   * snapshot's site options, the way it does on a real deploy. Everything it
   * touches is restored below, including that file.
   *
   * This is the acceptance test for building from Open Publish, end to end,
   * against a synthetic bucket served over loopback. `test/snapshot.test.ts`
   * covers the script's own behaviour (the signing, the checks, the mapping)
   * and what only a real `dist/` can answer is here: that a note is served at
   * the slug the plugin published it at, that the address it used to have 301s
   * to that slug **without moving the note**, that a link to something
   * unpublished is inert, and that the marker the plugin polls carries the
   * snapshot id `current.json` named.
   *
   * The bucket ignores the request signature. SigV4 has its own tests, and a
   * fixture that verified it would only be testing them.
   */
  section('An Open Publish snapshot is served at the addresses it was published at')
  {
    const configPath = join(ROOT, 'jotter.config.ts')
    const original = await readFile(configPath, 'utf8')
    const statePath = join(ROOT, '.op-build-state.json')
    const VAULT = join(tmpdir(), `jotter-op-${process.pid}`)

    const sha256 = (data) => createHash('sha256').update(data).digest('hex')

    /**
     * A vault as the plugin publishes one: clean slugs, one note carrying the
     * Obsidian Publish address it used to answer at, one rename, one attachment
     * whose name would not survive slugification, and one link to a note that
     * was never published.
     */
    const FILES = {
      'Notes/Home.md': {
        /**
         * With a `permalink:` that disagrees with the slug the plugin gives it,
         * because that combination is what silently broke a real site. The
         * plugin promotes the homepage to `index` and this note is written to
         * `index.md`; its own frontmatter then moved it straight back out,
         * `applyPermalinks` running before anything claims the root, and `/`
         * fell through to the generated index page with every layer having done
         * what it was told.
         */
        body:
          '---\npermalink: home\n---\n\n# Home\n\nSee [[Critical Thinking]], [[Plain]] and [[Draft Note]].\n\n' +
          '![[My Diagram.svg]]\n',
        entry: {
          slug: 'index',
          title: 'Home',
          // Promoted to `/` *and* migrated: the note has an old Obsidian
          // Publish URL as well as a rename, and both have to end up at `/`.
          legacyUrls: ['Notes/Home'],
          // Real stats, because the whole point of carrying them is that this
          // vault is written fresh and has no dates of its own.
          ctime: Date.UTC(2024, 2, 14),
          mtime: Date.UTC(2026, 0, 9),
        },
      },
      'Wisdom & Approaches/Critical Thinking.md': {
        body: '# Critical Thinking\n\nA note that kept the address it was published at.\n',
        entry: {
          slug: 'wisdom-approaches/critical-thinking',
          title: 'Critical Thinking',
          legacyUrls: ['Wisdom+&+Approaches/Critical+Thinking'],
          ctime: Date.UTC(2024, 2, 14),
          mtime: Date.UTC(2026, 0, 9),
        },
      },
      'Wisdom & Approaches/NVC.md': {
        body: '# NVC\n\nA sibling, so the note above has a neighbour to link to.\n',
        entry: {
          slug: 'wisdom-approaches/nvc',
          title: 'NVC',
          ctime: Date.UTC(2024, 2, 15),
          mtime: Date.UTC(2026, 0, 10),
        },
      },
      'Notes/Plain.md': {
        body: '# Plain\n\nNothing special about this one.\n',
        entry: { slug: 'notes/plain', title: 'Plain' },
      },
      'attachments/My Diagram.svg': {
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>\n',
        entry: { slug: 'attachments/my-diagram.svg' },
      },
    }

    const LEGACY = '/Wisdom+%26+Approaches/Critical+Thinking'
    const SLUG = '/wisdom-approaches/critical-thinking'

    const files = {}
    const objects = new Map()
    for (const [path, { body, entry }] of Object.entries(FILES)) {
      const buffer = Buffer.from(body, 'utf8')
      const hash = sha256(buffer)
      files[path] = { hash, size: buffer.length, mtime: 0, ...entry }
      objects.set(`objects/${hash.slice(0, 2)}/${hash}`, buffer)
    }

    const snapshot = {
      version: 1,
      id: '2026-08-29T09-00-00Z-verify',
      parent: null,
      createdAt: 0,
      generator: { plugin: 'open-publish', version: 'verify' },
      site: {
        title: 'Fixture Garden',
        homepage: 'Notes/Home.md',
        // Persian, because the language and the direction derived from it are
        // the two site options whose only visible effect is on `<html>`, and
        // nothing short of a real build can show they got there.
        locale: 'fa-IR',
        dir: 'rtl',
        noIndex: false,
        showThemeToggle: true,
        strictLineBreaks: false,
        showNavigation: true,
        showSearch: false,
        showGraph: false,
        showOutline: true,
        showBacklinks: true,
        showTags: true,
        // On, against the default, so the block below is asserted against the
        // option rather than against jotter's own layout. Off is what a fresh
        // install already does.
        showPageMetadata: true,
        showPrevNext: true,
        analytics: { provider: 'none', id: '' },
      },
      files,
      links: {
        'Notes/Home.md': [
          {
            raw: 'Critical Thinking',
            target: 'Wisdom & Approaches/Critical Thinking.md',
            status: 'published',
            slug: 'wisdom-approaches/critical-thinking',
          },
          { raw: 'Plain', target: 'Notes/Plain.md', status: 'published', slug: 'notes/plain' },
          { raw: 'Draft Note', target: 'Drafts/Draft Note.md', status: 'unpublished' },
          {
            raw: 'My Diagram.svg',
            target: 'attachments/My Diagram.svg',
            status: 'published',
            slug: 'attachments/my-diagram.svg',
            embed: true,
          },
        ],
      },
      redirects: [{ from: 'notes/home', to: 'index' }],
    }

    const keys = new Map([
      ...objects,
      ['current.json', Buffer.from(JSON.stringify({ version: 1, snapshot: snapshot.id, updatedAt: 0 }))],
      [`snapshots/${snapshot.id}.json`, Buffer.from(JSON.stringify(snapshot))],
    ])

    const server = createServer((req, res) => {
      const key = decodeURIComponent((req.url ?? '').replace(/^\/fixture\//, '').split('?')[0])
      const body = keys.get(key)
      if (!body) {
        res.statusCode = 404
        return res.end('not found')
      }
      res.end(body)
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const port = server.address().port

    const env = {
      ...process.env,
      OP_ENDPOINT: `http://127.0.0.1:${port}`,
      OP_BUCKET: 'fixture',
      OP_ACCESS_KEY_ID: 'key',
      OP_SECRET_ACCESS_KEY: 'secret',
      JOTTER_VAULT_OVERRIDE: VAULT,
    }

    try {
      await rm(VAULT, { recursive: true, force: true })
      await clearContentStores(ROOT)

      const fetched = await runNode([join(ROOT, 'scripts', 'fetch-content.mjs')], { env })
      if (fetched.code !== 0) {
        fail('fetch-content turns a snapshot into a vault', fetched.out.slice(-800))
      } else {
        check(
          fetched.out.includes('REGENERATED'),
          'the build says out loud that it overwrote jotter.config.ts',
        )

        /**
         * The headline claim, checked on disk before anything renders: the note
         * body is byte for byte what its author wrote. The Quartz starter has
         * to rewrite every wikilink into a resolved `[label](/slug)` because
         * Quartz cannot be told the answers; jotter is told, in
         * `.jotter/links.json`, and so touches nothing but the frontmatter.
         */
        const home = await readFile(join(VAULT, 'index.md'), 'utf8')
        check(
          home.includes('[[Critical Thinking]]') && home.includes('![[My Diagram.svg]]'),
          'no wikilink in a note body was rewritten',
        )
        check(/^title: "?Home"?$/m.test(home), 'the snapshot’s resolved title reached the note')
        /**
         * The stale instruction, gone. Everything below it depends on this: the
         * note cannot be served at `/` while its own frontmatter names another
         * address.
         */
        check(
          !/^permalink:/m.test(home),
          'the permalink the plugin overruled was dropped from the note',
          home.split('\n').slice(0, 10).join(' | '),
        )
        /**
         * Both address keys, on the one note that has both kinds. Merged into a
         * single `oldUrls:` they were indistinguishable by the time
         * `buildRedirectRules` read them, so every rule it wrote was permanent,
         * including the ones a later build withdraws.
         */
        check(
          /oldUrls:(\s*\n\s+-)? ?"?Notes\/Home"?/.test(home) &&
            /renamedFrom:(\s*\n\s+-)? ?"?notes\/home"?/.test(home),
          'the published address and the rename arrived under separate keys',
          home.split('\n').slice(0, 10).join(' | '),
        )
        /** And the overruled permalink kept working, as an address it moved from. */
        check(
          /renamedFrom:[\s\S]{0,80}home\b/.test(home),
          'and the overruled permalink was kept as an address, not discarded',
          home.split('\n').slice(0, 10).join(' | '),
        )

        const critical = await readFile(
          join(VAULT, 'wisdom-approaches', 'critical-thinking.md'),
          'utf8',
        )
        check(
          critical.includes('oldUrls: ["Wisdom+&+Approaches/Critical+Thinking"]'),
          'an old address arrived as an old URL, not as a permalink',
          critical.split('\n').slice(0, 5).join(' | '),
        )
        /**
         * And not as an alias, which is where these used to go. Both spellings
         * become 301s, so the redirect below passes either way; the difference
         * is that `Frontmatter.astro` prints `aliases` on the page under "Also
         * known as", so every note on a migrated site displayed a `+`-encoded
         * routing artifact as human metadata.
         */
        check(
          !/^aliases:.*Wisdom/m.test(critical),
          'and never as an alias, which the page would print as a name',
          critical.split('\n').slice(0, 5).join(' | '),
        )

        check(
          (await stat(join(VAULT, 'attachments', 'My Diagram.svg')).catch(() => null)) !== null,
          'an attachment kept its vault path rather than taking its slug',
        )

        /**
         * The dates the vault directory cannot supply. It was written seconds
         * ago from a snapshot, so frontmatter, git and mtime, the three
         * fallbacks in `src/lib/dates.ts`, all resolve to *now*. Without the
         * snapshot's own stats every note on the site reads as created on the
         * day of the last deploy.
         */
        check(
          critical.includes('created: "2024-03-14T00:00:00.000Z"') &&
            critical.includes('updated: "2026-01-09T00:00:00.000Z"'),
          'the note carries the dates the snapshot knew, not the build’s clock',
          critical.split('\n').slice(0, 6).join(' | '),
        )

        const generated = await readFile(configPath, 'utf8')
        check(/"slugs": "preserve"/.test(generated), 'the generated config preserves the plugin’s slugs')
        /**
         * Notes are written at their slugs, so the folder tree is derived from
         * a path that is already slugified. The real names are recovered from
         * the manifest, whose keys are vault paths.
         */
        check(
          /"wisdom-approaches": "Wisdom & Approaches"/.test(generated),
          'the folder kept the name the vault gave it, not its slug',
          generated.slice(-400),
        )
        check(
          /"metadata": true/.test(generated) && /"prevNext": true/.test(generated),
          'the two newest site options reached the generated config',
        )
        check(
          /"locale": "fa-IR"/.test(generated) && /"dir": "rtl"/.test(generated),
          'the language and its direction reached the generated config',
        )
        check(
          !fetched.out.includes('ignoring site option'),
          'and neither was reported as an option this version does not understand',
          fetched.out.slice(-400),
        )

        await clearContentStores(ROOT)
        const { code, out } = await run(['astro', 'build'], { env })

        if (code !== 0) {
          fail('the fetched vault builds', out.slice(-800))
        } else {
          const finalized = await runNode([join(ROOT, 'scripts', 'finalize.mjs')], { env })
          check(finalized.code === 0, 'finalize writes the marker the plugin polls', finalized.out.slice(-400))

          const onPages = await Promise.all(
            (await walk(DIST, (n) => n.endsWith('.html'))).map(async (file) => ({
              file: relative(DIST, file),
              html: await readFile(file, 'utf8'),
            })),
          )

          /** Every note at the slug the plugin gave it, and the homepage at `/`. */
          for (const [path, { entry }] of Object.entries(FILES)) {
            if (!path.endsWith('.md')) continue
            const page = pageFileFor(entry.slug)
            check(
              (await stat(page).catch(() => null)) !== null,
              `${path} is served at /${entry.slug === 'index' ? '' : entry.slug}`,
              `no page at ${relative(DIST, page)}`,
            )
          }

          // The whole point of carrying `dir` in the snapshot rather than
          // leaving each starter to re-derive it: the answer arrives, and the
          // page says it.
          const [{ html: anyPage }] = onPages
          check(
            /<html lang="fa-IR"/.test(anyPage),
            'the published language reaches <html lang>',
            anyPage.slice(0, 120),
          )
          check(
            /<html [^>]*dir="rtl"/.test(anyPage),
            'and the direction derived from it reaches <html dir>',
            anyPage.slice(0, 120),
          )

          const netlify = await readFile(join(DIST, '_redirects'), 'utf8').catch(() => '')

          /**
           * The acceptance criterion, in one line: the URL Obsidian Publish
           * served this note at 301s to the slug the plugin published it at.
           * `aliases:` -> `sourceFor(alias, 'preserve')` -> the single
           * `encodeSlug` in `src/lib/redirects.ts`, so `&` is percent-encoded
           * exactly once and `+` is left alone.
           */
          check(
            netlify.includes(`${LEGACY} ${SLUG} 301`),
            `${LEGACY} 301s to ${SLUG}`,
            netlify.trim().split('\n').join(' | '),
          )
          /**
           * The homepage promotion, which is the case this whole section exists
           * for and the one that is easiest to lose.
           *
           * Under `slugs: 'preserve'` the promoted note is written to disk *at*
           * `index.md`, so `buildRedirects`' vacated-slug rule short-circuits
           * (`from === to`) and `claim()` refuses `index` as a source outright.
           * The old address survives on one path only: the plugin's rename rule
           * `{from: 'notes/home', to: 'index'}` reaching `redirectFromsFor`.
           * Delete that and every link anyone ever published to the note that
           * is now the front page 404s, with nothing else in the build noticing.
           */
          check(
            netlify.includes('/notes/home / 302'),
            'a note renamed into the homepage still answers at its old slug',
            netlify.trim().split('\n').join(' | '),
          )
          /**
           * The homepage bug, stated as the thing a reader would check: the
           * note the plugin set as the homepage is served at `/`, and the
           * address its own `permalink:` named still redirects there rather
           * than holding the page hostage.
           */
          check(
            netlify.includes('/home / 302'),
            'and at the address its overruled permalink named',
            netlify.trim().split('\n').join(' | '),
          )
          /**
           * And the same for the address Obsidian Publish served it at, which
           * arrives by the other route: `legacyUrls` -> `oldUrls:` -> the same
           * `claim()`. Two sources, one destination, and `/` is a real page.
           */
          check(
            netlify.includes('/Notes/Home / 301'),
            'and at the URL Obsidian Publish served the same note at',
            netlify.trim().split('\n').join(' | '),
          )
          check(
            !/^\/index /m.test(netlify) && !/ \/index 30\d$/m.test(netlify),
            'and nothing redirects to or from /index, which is not a URL this site serves',
            netlify.trim().split('\n').join(' | '),
          )

          /**
           * The status split, end to end and on one note. Both rules above
           * point at `/`, both were `301` until a browser holding a withdrawn
           * one started looping, and the difference between them is not
           * visible anywhere else in this build: `Notes/Home` is an address
           * publish.obsidian.md served and cannot un-serve, while
           * `notes/home` is this site's own history and reverses the moment
           * the note is renamed back. See `RedirectRule` in
           * `src/lib/redirects.ts`.
           */
          check(
            !netlify.includes('/notes/home / 301') && !netlify.includes('/Notes/Home / 302'),
            'and the frozen address is the permanent one, not the rename',
            netlify.trim().split('\n').join(' | '),
          )

          /**
           * And the other half of that criterion, which is the half a permalink
           * would have broken: the note did not move. Nothing redirects away
           * from the slug it is served at.
           */
          check(
            !new RegExp(`^${SLUG} `, 'm').test(netlify),
            'and the note itself did not move',
            netlify.trim().split('\n').join(' | '),
          )

          const homePage = onPages.find((p) => p.file === 'index.html')?.html ?? ''
          check(
            homePage.includes(`href="${SLUG}"`),
            'the link index resolved a wikilink to the published slug',
          )
          check(
            /<span class="dead-link">Draft Note<\/span>/.test(homePage),
            'a link to an unpublished note is an inert span, labelled with what the author typed',
          )
          check(
            !/href="[^"]*[Dd]raft/.test(homePage),
            'and nothing on the page links to it',
          )
          check(
            homePage.includes('/_vault/attachments/My%20Diagram.svg'),
            'an embed resolved to the attachment at its vault path',
          )

          /* -- what the reader sees, for the four defects this fixture carries -- */

          const criticalPage =
            onPages.find((p) => p.file === `wisdom-approaches${sep}critical-thinking.html`)?.html ?? ''

          check(
            criticalPage.includes('>Wisdom &amp; Approaches<'),
            'the folder reads by its real name in the breadcrumb and the sidebar',
            criticalPage.includes('>wisdom-approaches<') ? 'it reads as its slug' : 'no crumb found',
          )
          check(
            !/Also known as/.test(criticalPage),
            'no page shows an old URL as a name the note answers to',
          )
          check(
            /<time datetime="2024-03-14/.test(criticalPage),
            'the metadata block shows the date the note was written, not the date of the build',
            criticalPage.match(/<time datetime="[^"]*"/)?.[0] ?? 'no <time> on the page',
          )
          /**
           * Neighbours are siblings under one folder. `NVC` is the only other
           * note in `Wisdom & Approaches`, so it is the only link that belongs
           * here; the flat-list ordering this replaced would have reached for
           * whatever sorted next across the whole vault.
           */
          const prevNext = criticalPage.slice(criticalPage.indexOf('<nav class="prev-next"'))
          check(
            /<nav class="prev-next"/.test(criticalPage) &&
              prevNext.includes('/wisdom-approaches/nvc') &&
              !prevNext.includes('/notes/plain'),
            'previous and next stay inside the note’s own folder',
            prevNext.slice(0, 300),
          )

          const marker = JSON.parse(await readFile(join(DIST, '_publish.json'), 'utf8'))
          check(
            marker.snapshot === snapshot.id,
            'dist/_publish.json carries the snapshot current.json named',
            `${marker.snapshot} != ${snapshot.id}`,
          )
          const headers = await readFile(join(DIST, '_headers'), 'utf8').catch(() => '')
          check(
            /\/_publish\.json[\s\S]*Cache-Control: no-store/.test(headers),
            'and a CDN is told not to cache it',
            headers.trim().split('\n').join(' | '),
          )

          await internalLinks(onPages)
          await redirectsAndRobots()
        }
      }
    } finally {
      await new Promise((done) => server.close(done))
      await writeFile(configPath, original)
      await rm(statePath, { force: true })
      await rm(VAULT, { recursive: true, force: true })
      await clearContentStores(ROOT)
    }
  }

  /**
   * The fourth config rewrite, and the only thing that can prove the direction
   * feature is *symmetric* rather than merely working.
   *
   * `dir` is flipped rather than set to `rtl`, so this is honest for a forker
   * whose site already is RTL. Flipping is what makes the assertion below
   * meaningful either way: whatever language the demo vault is mostly written
   * in becomes the minority, so every block of it must now be marked with the
   * direction the site used to have. On the committed config that reads
   * "an English paragraph carrying `dir='ltr'` on an RTL site", which is the
   * exact mirror of the main pass and the case that catches an implementation
   * able to emit only `rtl`.
   *
   * Turning `dir: 'rtl'` on in the committed `jotter.config.ts` is the wrong
   * way to get this: the demo garden is written in English, and a right-to-left
   * English site is not a thing anyone should fork. A throwaway rebuild costs
   * one `astro build`.
   */
  section('The mirror: an RTL rebuild marks the other half')
  {
    const configPath = join(ROOT, 'jotter.config.ts')
    const original = await readFile(configPath, 'utf8')

    const was = /\bdir:\s*'(ltr|rtl)'/.exec(original)?.[1] ?? 'ltr'
    const flipped = was === 'ltr' ? 'rtl' : 'ltr'
    const on = /\bdir:\s*'(?:ltr|rtl)'/.test(original)
      ? original.replace(/\bdir:\s*'(?:ltr|rtl)'/, `dir: '${flipped}'`)
      : original.replace(CALL, `export default defineConfig({\n  dir: '${flipped}',`)

    if (!new RegExp(`dir:\\s*'${flipped}'`).test(on)) {
      fail(
        'the direction rewrite reached jotter.config.ts',
        'no dir key was written; the checks below would be vacuous',
      )
    } else {
      await writeFile(configPath, on)
      await clearContentStores(ROOT)

      const { code, out } = await run(['astro', 'build'])
      if (code !== 0) {
        fail(`build succeeds with dir: '${flipped}'`, out.slice(-800))
      } else {
        const flippedPages = await Promise.all(
          (await walk(DIST, (n) => n.endsWith('.html'))).map(async (file) => ({
            file: relative(DIST, file),
            html: await readFile(file, 'utf8'),
          })),
        )
        const flippedOutputs = await Promise.all(
          (await walk(DIST, (n) => TEXT_OUTPUT.test(n) || n === '_redirects')).map(async (file) => ({
            file: relative(DIST, file),
            text: await readFile(file, 'utf8'),
          })),
        )

        /**
         * Every assertion the main pass makes, run again with the site the
         * other way round. `directionSection` is stated against each page's own
         * `<html dir>` rather than against a literal, which is what lets it run
         * here unchanged, and what makes "no block repeats what it inherits"
         * mean the opposite thing in the right way.
         */
        directionSection(flippedPages, flippedOutputs)

        const wrongRoot = flippedPages.filter(
          ({ html }) => !new RegExp(`<html[^>]+\\bdir="${flipped}"`).test(html),
        )
        check(
          wrongRoot.length === 0,
          `every page declares dir="${flipped}" when the config says so`,
          wrongRoot.map((p) => p.file).join(', '),
        )

        /**
         * The mirror itself, stated positively. Nothing else in this file can
         * see the difference between "marks the minority language" and "marks
         * right-to-left text".
         */
        const mirrored = flippedPages.filter(({ html }) =>
          new RegExp(`<p dir="${was}">`).test(html),
        )
        check(
          mirrored.length > 0,
          `a prose block still running ${was} is marked dir="${was}"`,
          `no <p dir="${was}"> on any page: the feature only emits one direction`,
        )
      }

      await writeFile(configPath, original)
      await clearContentStores(ROOT)
    }
  }

  /**
   * The regression this whole vocabulary exists for: an ordinary vault, holding
   * none of this repository's fixtures, verifies clean.
   *
   * It is built from the shape that actually failed. A real site published from
   * the Open Publish plugin, with 96 notes, 114 pages and every content
   * assertion green, was refused by this script with eight failures, and its
   * author's fix was to delete `verify-build.mjs` from their build command.
   * Five of the eight were guards on fixtures that exist only in
   * `src/content/notes/`; the other three were true statements about content
   * they were entitled to write. So the vault below has a folder called
   * `notes`, two PDF embeds, a tweet URL and a YouTube URL written as
   * `![](…)`, and none of the demo's dead links, SVG, `kitchen-sink` probe or
   * excluded note.
   *
   * The real script is spawned rather than re-entered, with `JOTTER_DEMO`
   * removed from its environment. CI sets it, and a check on the demo running
   * here would test the opposite of what this section is for. Its exit code is
   * the assertion: `0`, or the deploy this is standing in for would not happen.
   */
  section('A vault with none of the demo fixtures verifies clean')
  {
    const MINIMAL = join(tmpdir(), `jotter-minimal-${process.pid}`)
    const files = {
      'index.md': '---\ntitle: Home\n---\n\n# Home\n\nNotes: [[000 Notes]] and [[Integrity]].\n',
      // A folder called `notes`, which the listing check used to read as its
      // own `/notes` page and fail every note underneath it.
      'notes/000 Notes.md':
        '---\ntitle: Notes\n---\n\n# Notes\n\nOne of them is [[999 OpenAI o1 models]].\n',
      // The callout is load-bearing. It is a `<div>` inside the note body, and
      // the embeds come after it: if `proseParts` ever goes back to ending the
      // body at the first `</div>`, both land on jotter's side of the split and
      // fail this build instead of reporting.
      'notes/999 OpenAI o1 models.md':
        '---\ntitle: OpenAI o1 models\n---\n\n# o1\n\n' +
        '> [!note] Worth a look\n> A callout, which is a div.\n\n' +
        '![](https://twitter.com/someone/status/1834417901081694320?s=4)\n\n' +
        '![](https://www.youtube.com/watch?v=l7TONauJGfc)\n' +
        '\n![](https://cdn.example.com/no-dimensions.gif)\n',
      'Wisdom & Approaches/Integrity.md':
        '---\ntitle: Integrity\n---\n\n# Integrity\n\n![[Integrity.pdf]]\n\n![[Integrity-fa.pdf]]\n',
      // Never opened by anything: what is being verified is the markup a `.pdf`
      // in the vault produces, not the document.
      'Wisdom & Approaches/attachments/Integrity.pdf': '%PDF-1.4\n',
      'Wisdom & Approaches/attachments/Integrity-fa.pdf': '%PDF-1.4\n',
    }

    await rm(MINIMAL, { recursive: true, force: true })
    await mkdir(MINIMAL, { recursive: true })
    for (const [path, body] of Object.entries(files)) {
      const parts = path.split('/')
      if (parts.length > 1) await mkdir(join(MINIMAL, ...parts.slice(0, -1)), { recursive: true })
      await writeFile(join(MINIMAL, ...parts), body)
    }

    await clearContentStores(ROOT)
    const built = await run(['astro', 'build'], {
      env: { ...process.env, JOTTER_VAULT_OVERRIDE: MINIMAL },
    })

    if (built.code !== 0) {
      fail('a vault with none of the demo fixtures builds', built.out.slice(-800))
    } else {
      const { JOTTER_DEMO: _demo, ...withoutDemo } = process.env
      const verified = await runNode([join(ROOT, 'scripts', 'verify-build.mjs')], {
        env: withoutDemo,
      })
      check(
        verified.code === 0,
        'and passes verification, with nothing skipped that should have failed',
        verified.out
          .split('\n')
          .filter((line) => /^\s*(FAIL|\s{8}\S)/.test(line))
          .join('\n        ')
          .slice(0, 900),
      )
      /**
       * And the PDF embeds are documents. Without this the check above would
       * still pass on the `<img src="Integrity.pdf">` this section was written
       * for: no browser renders it, and no assertion here would have noticed
       * once the width and height claim stopped being fatal.
       *
       * Three claims, because `![[Integrity.pdf]]` makes three promises: the
       * frame the author asked for, lazily, with a way out of it if the frame
       * comes up blank.
       */
      const integrity = await readFile(
        pageFileFor('wisdom-approaches/integrity'),
        'utf8',
      ).catch(() => '')
      check(
        /<iframe[^>]+src="[^"]+\.pdf"/.test(integrity) && !/<img[^>]+\.pdf/.test(integrity),
        'a PDF embed is a frame rather than an <img> no browser can draw',
        integrity ? '' : 'no page was built for the note that embeds them',
      )
      /**
       * The attribute, and only the attribute. Chrome 152 fetches the whole
       * file anyway, measured against a logging server; this asserts that
       * jotter still declares the intent, not that any byte was saved.
       */
      check(
        [...integrity.matchAll(/<iframe\b[^>]*>/g)].every(([tag]) => /loading="lazy"/.test(tag)),
        'and declares loading="lazy", which Chrome does not yet honour on a frame',
      )
      check(
        /<a class="file-embed"[^>]+\.pdf"/.test(integrity),
        'and carries the link a blank frame on a phone would otherwise leave no way past',
      )
    }

    await rm(MINIMAL, { recursive: true, force: true })
    await clearContentStores(ROOT)
  }

  /**
   * At whatever `jotter.config.ts` currently says, which is the honest thing
   * for it to do: a forker running this gets their own feature set measured.
   *
   * On the committed default that means **search is off here**, so Pagefind's
   * indexing time is not in the 60s number below. Measured by hand once, at
   * this same 1,000-note vault: 597ms to index and 380ms to write, so about
   * **1.0s**, against a 60s envelope: 1.7%, and it does not grow with the
   * number of *pages* so much as with the amount of prose. The index directory
   * lands at 4.2 MB, none of which a reader downloads until they search.
   *
   * Left off rather than forced on, because a second before the ceiling cannot
   * be what fails this check, and a Pagefind regression at scale is Pagefind's
   * to catch. Turn `features.search` on in your own config and this pass covers
   * it for free. Re-measure if that 1.0s is ever load-bearing.
   */
  section('Scale')
  {
    const SCALE = join(tmpdir(), `jotter-scale-${process.pid}`)
    await mkdir(SCALE, { recursive: true })
    const N = 1000
    for (let i = 0; i < N; i++) {
      const folder = `topic-${i % 25}`
      await mkdir(join(SCALE, folder), { recursive: true })
      const links = [0, 1, 2].map((k) => `[[Note ${(i * 7 + k * 131) % N}]]`).join(', ')
      await writeFile(
        join(SCALE, folder, `Note ${i}.md`),
        `---\ntitle: Note ${i}\ntags: [topic/${i % 25}]\n---\n\n# Note ${i}\n\nLinks to ${links}.\n\nSome prose with a ==highlight== and a #tag${i % 40}.\n`,
      )
    }

    const started = Date.now()
    const { code, out } = await run(['astro', 'build'], {
      env: { ...process.env, JOTTER_VAULT_OVERRIDE: SCALE },
    })
    const seconds = (Date.now() - started) / 1000

    if (code !== 0) {
      fail(`${N}-note vault builds`, out.slice(-800))
    } else if (seconds < 60) {
      pass(`${N}-note vault builds in under 60s`, `took ${seconds.toFixed(1)}s`)
    } else {
      // Degrade loudly, never silently cap: the build still produced every
      // page, it just took longer than the tested envelope.
      fail(`${N}-note vault builds in under 60s`, `took ${seconds.toFixed(1)}s`)
    }
    await rm(SCALE, { recursive: true, force: true })
    await clearContentStores(ROOT)
  }
}

/* ------------------------------------------------------------- summary */

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
console.log(FULL ? 'All checks passed, including the full suite.' : 'All checks passed.')
