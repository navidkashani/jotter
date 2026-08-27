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
 *   npm run verify          the checks above, over the current dist/
 *   npm run verify:full     also rebuilds with features off, and at scale
 */
import { readFile, readdir, stat, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, relative, extname, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

import { readTokens, contrastOklch } from './lib/color.mjs'
import { runningDevServers, devServerWarning } from './lib/dev-server.mjs'
import { clearContentStores } from './lib/astro-cache.mjs'

const ROOT = join(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const FULL = process.argv.includes('--full')

let failures = 0
let warnings = 0

const pass = (label, detail = '') => console.log(`  ok    ${label}${detail ? `  ${detail}` : ''}`)
const fail = (label, detail = '') => {
  failures++
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
}
const warn = (label, detail = '') => {
  warnings++
  console.log(`  warn  ${label}${detail ? `\n        ${detail}` : ''}`)
}
const check = (ok, label, detail = '') => (ok ? pass(label) : fail(label, detail))
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

/** Everything inside the rendered note body, where our markdown output lands. */
const proseOf = (html) =>
  [...html.matchAll(/<div class="note-body prose">([\s\S]*?)<nav class="prev-next"|<div class="note-body prose">([\s\S]*?)<\/div>/g)]
    .map((m) => m[1] ?? m[2] ?? '')
    .join('\n')

console.log(`Verifying ${pages.length} page(s) in dist/\n`)

/* ------------------------------------------------------------------ links */

section('Links')
{
  const emptyHref = pages.filter(({ html }) =>
    /<a\b[^>]*href=(""|'')/.test(html) || /href="undefined"/.test(html) || /href="null"/.test(html),
  )
  check(emptyHref.length === 0, 'no <a> with an empty, undefined or null href', emptyHref.map((p) => p.file).join(', '))

  const anchorDeadLinks = pages.filter(({ html }) => /<a\b[^>]*class="[^"]*dead-link/.test(html))
  check(anchorDeadLinks.length === 0, 'every dead link is a <span>, never an <a>', anchorDeadLinks.map((p) => p.file).join(', '))

  const hrefOnSpan = pages.filter(({ html }) => /<span\b[^>]*\bhref=/.test(html))
  check(hrefOnSpan.length === 0, 'no href attribute left on a dead-link span', hrefOnSpan.map((p) => p.file).join(', '))

  const deadLinkPages = pages.filter(({ html }) => html.includes('class="dead-link"'))
  check(deadLinkPages.length > 0, 'the demo actually exercises dead links', 'no dead-link span found anywhere')
}

/* ----------------------------------------------------------------- images */

section('Images')
{
  const offenders = []
  for (const { file, html } of pages) {
    for (const [tag] of html.matchAll(/<img\b[^>]*>/g)) {
      if (!/\bwidth=/.test(tag) || !/\bheight=/.test(tag)) offenders.push(`${file}: ${tag.slice(0, 120)}`)
    }
  }
  check(offenders.length === 0, 'every <img> declares width and height', offenders.join('\n        '))

  const total = pages.reduce((n, p) => n + [...p.html.matchAll(/<img\b/g)].length, 0)
  check(total > 0, 'the demo actually renders images')

  const optimized = pages.some(({ html }) => /<img[^>]+src="\/_astro\/[^"]+\.(webp|avif)"/.test(html))
  check(optimized, 'raster embeds go through Astro’s image pipeline')

  const svgPassthrough = pages.some(({ html }) => /<img[^>]+src="\/_vault\/[^"]+\.svg"/.test(html))
  check(svgPassthrough, 'SVG is passed through rather than re-encoded')
}

/* ------------------------------------------------------- the privacy gate */

section('Publish gate')
{
  const PRIVATE_TITLE = 'A title that must never reach the site'
  const leaked = pages.filter(({ html }) => html.includes(PRIVATE_TITLE))
  check(leaked.length === 0, 'no unpublished note’s title appears anywhere in dist/', leaked.map((p) => p.file).join(', '))

  const routed = htmlFiles.some((f) => /half-formed/i.test(f))
  check(!routed, 'no unpublished note has a page of its own')

  const linkedTo = pages.some(({ html }) => /href="[^"]*half-formed/i.test(html))
  check(!linkedTo, 'nothing links to an unpublished note')
}

/* -------------------------------------------- the compressHTML: jsx trap */

section('Inline whitespace (the compressHTML: \'jsx\' trap)')
{
  const kitchenSink = pages.find((p) => p.file.includes('kitchen-sink'))
  if (!kitchenSink) {
    fail('the whitespace probe page exists', 'kitchen-sink not found in dist/')
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
      check(pattern.test(html), label, 'whitespace was stripped between inline elements')
    }
  }

  // Anything else in the demo where two inline elements touch with no
  // separator is suspicious, but a user's own prose can do this legitimately,
  // so it is reported rather than failed.
  const adjacency = /<\/(a|em|strong|code|mark)><(a|em|strong|code|mark)[\s>]/g
  const suspicious = pages.filter((p) => adjacency.test(proseOf(p.html)))
  if (suspicious.length) {
    warn('inline elements touching with no separator', suspicious.map((p) => p.file).join(', '))
  } else {
    pass('no inline elements touching with no separator')
  }
}

/* -------------------------------------------------------------- structure */

section('Markup')
{
  const nested = pages.filter(({ html }) =>
    /<p>(?:(?!<\/p>)[\s\S])*?<(figure|div class="callout"|details|aside|blockquote|table|pre)/.test(proseOf(html)),
  )
  check(nested.length === 0, 'no block element nested inside a <p>', nested.map((p) => p.file).join(', '))

  const landmarks = pages.filter(({ html }) => !/<main\b/.test(html))
  check(landmarks.length === 0, 'every page has a <main> landmark', landmarks.map((p) => p.file).join(', '))

  const skip = pages.filter(({ html }) => !/class="skip-link"/.test(html))
  check(skip.length === 0, 'every page has a skip link', skip.map((p) => p.file).join(', '))

  const lang = pages.filter(({ html }) => !/<html[^>]+lang="/.test(html))
  check(lang.length === 0, 'every page declares a lang')

  const titled = pages.filter(({ html }) => !/<title>[^<]+<\/title>/.test(html))
  check(titled.length === 0, 'every page has a non-empty title')

  const altless = []
  for (const { file, html } of pages) {
    for (const [tag] of html.matchAll(/<img\b[^>]*>/g)) {
      if (!/\balt=/.test(tag)) altless.push(`${file}: ${tag.slice(0, 100)}`)
    }
  }
  check(altless.length === 0, 'every <img> has an alt attribute', altless.join('\n        '))
}

/* ------------------------------------------------------------------- CSS */

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
    if (name === 'tokens.css' || name === 'print.css') continue

    const source = await readFile(file, 'utf8')
    source.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\*[\s\S]*?\*\//g, '')
      if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) return
      if (COLOUR.test(code) && !/var\(--/.test(code) && !/currentColor|transparent|inherit|none/i.test(code)) {
        offenders.push(`${name}:${i + 1}  ${line.trim()}`)
      }
    })
  }
  check(offenders.length === 0, 'no colour literal outside tokens.css', offenders.join('\n        '))

  // Physical properties are how RTL support rots. Logical ones cost nothing.
  const PHYSICAL = /(?:^|[\s;{])(?:padding|margin|border)-(?:left|right)\b|(?:^|[\s;{])(?:left|right|top|bottom)\s*:/
  const physical = []
  for (const file of [...cssFiles, ...(await walk(join(ROOT, 'src'), (n) => n.endsWith('.astro')))]) {
    const name = relative(ROOT, file)
    if (name.endsWith('print.css')) continue
    const source = await readFile(file, 'utf8')
    source.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\*[\s\S]*?\*\//g, '')
      if (/^\s*[*/]/.test(line)) return
      if (PHYSICAL.test(code)) physical.push(`${name}:${i + 1}  ${line.trim()}`)
    })
  }
  check(physical.length === 0, 'no physical inset or spacing properties (RTL safety)', physical.join('\n        '))

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
    check(bad.length === 0, `WCAG AA contrast holds in the ${theme} theme`, bad.join('\n        '))
  }
}

/* ------------------------------------------------------------ redirects */

section('Redirects and robots')
{
  const netlify = await readFile(join(DIST, '_redirects'), 'utf8').catch(() => null)
  const vercel = await readFile(join(DIST, 'vercel.json'), 'utf8').catch(() => null)
  check(netlify !== null, '_redirects was written')
  check(vercel !== null, 'vercel.json was written')

  if (netlify && vercel) {
    const fromNetlify = netlify.trim().split('\n').filter(Boolean)
    const fromVercel = JSON.parse(vercel).redirects
    check(
      fromNetlify.length === fromVercel.length,
      'both redirect formats describe the same set',
      `${fromNetlify.length} vs ${fromVercel.length}`,
    )

    // A redirect pointing at a page that does not exist is worse than none.
    const routes = new Set(htmlFiles.map((f) => '/' + relative(DIST, f).replace(/\/?index\.html$/, '').replace(/\.html$/, '')))
    const dangling = fromVercel.filter((r) => !routes.has(r.destination) && r.destination !== '/')
    check(dangling.length === 0, 'every redirect points at a real page', dangling.map((r) => `${r.source} -> ${r.destination}`).join(', '))

    // And one that shadows a real page would make that page unreachable.
    const shadowing = fromVercel.filter((r) => routes.has(r.source))
    check(shadowing.length === 0, 'no redirect shadows a real page', shadowing.map((r) => r.source).join(', '))
  }

  const robots = await readFile(join(DIST, 'robots.txt'), 'utf8').catch(() => null)
  check(robots !== null, 'robots.txt was written')
}

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
   * cross-chunk imports in `dist/` today — one chunk, zero specifiers — so the
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
   * `750005b` fixed — billing one page for another's bytes.
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
      // A specifier that resolves to nothing in `dist/` is not ours to explain
      // — a bare module name, or a string that only looked like a path.
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
   * index. That was defensible while the graph was the only client code —
   * over-charging is the safe direction — but it stopped being defensible once
   * a 1.2 KB feature's fate depended on a number that was mostly somebody
   * else's chunk. It also made "the worst page" useless as a diagnostic, which
   * is the part a budget is actually for.
   *
   * Fixing the metric deliberately does *not* move the ceiling, and the
   * headroom it appears to hand back is worth reading carefully. Most pages
   * drop by around 20 KB — but the page this budget actually asserts against is
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
   * graph it is mounted from `Base.astro` — so its 6,096 bytes land on *every*
   * page, and on a note page they land on top of the graph's 20,824. That page
   * measures 29,301 bytes, and no amount of tightening either island closes a
   * 4,725-byte gap.
   *
   * So the ceiling moves once, to the smallest round number above the real
   * worst case with comparable headroom: 32,768, leaving 3,467. It is still a
   * ceiling on **one page**, still counted per page, and turning a feature off
   * still removes its bytes entirely. What it is not any more is a claim that
   * every jotter site fits in 24 KB — that was true of a build with one island
   * and stopped being true of a build with two.
   *
   * Worth knowing while reading a number close to it: Astro inlines a script
   * chunk under **4096 bytes** into the page rather than emitting a `.js` file,
   * so a small island never becomes a shared chunk at all — and an island that
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
   * is which *pages* may load which chunk — d3-force appearing on a tag index
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
   * an Obsidian vault — or a code sample a note links to — lands in the build.
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
   * Nothing here should be reaching the network at runtime — and that has to
   * be asserted over the bundled files as well as the inline blocks. Until the
   * graph there were no `.js` files at all in `dist/`, so grepping inline
   * bodies covered everything; the moment client code moves into
   * `dist/_astro/*.js` an inline-only grep would police nothing and still pass.
   */
  const NETWORK = /\bfetch\(|XMLHttpRequest|new WebSocket|navigator\.sendBeacon|EventSource\(/

  /**
   * One exemption, by path, and it is named rather than a loosening.
   *
   * Pagefind *fetches*, and that is not an implementation detail — loading
   * index chunks over plain GETs as you type is the entire design, and what
   * makes a 1,000-note vault searchable without shipping one enormous file.
   * There is no embed-it-at-build-time way out here the way there was for
   * hover previews, and a fully embedded index would contradict the scale
   * target the `--full` pass asserts two sections down.
   *
   * So `dist/pagefind/**` is allowed and **everything jotter authors still
   * fails on `fetch(`** — which is the half with teeth, and the half that keeps
   * the hover-preview decision enforced rather than merely documented. Delete
   * the filter and this check fails; that is the test that it is doing
   * anything.
   */
  const authored = (s) => !s.file.startsWith(`pagefind${sep}`)
  const fetches = [...scripts, ...chunks.values()].filter((s) => authored(s) && NETWORK.test(s.body))
  check(
    fetches.length === 0,
    'no runtime network requests from jotter’s own code',
    fetches.map((s) => s.file).join(', '),
  )
}

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
     * above walks *every* `.html` in `dist/` — so it would fail the skip-link,
     * `<main>`, `lang` and `<title>` assertions all at once, from a file
     * nobody in this repo wrote.
     */
    const html = await walk(indexDir, (n) => n.endsWith('.html'))
    check(html.length === 0, 'the search index ships no HTML page', html.map((f) => relative(DIST, f)).join(', '))

    /**
     * Parsed, not merely present, and every file non-empty.
     *
     * A build was once seen where `pagefind-entry.json` and `pagefind.js` came
     * out 0 bytes — the files existed, so a stat-only check would have passed
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

    const indexed = pages.filter(({ html }) => html.includes('data-pagefind-body'))
    check(indexed.length > 0, 'at least one page is marked as indexable')

    /**
     * The listing pages are deliberately out of the index: their content is
     * note titles and excerpts already indexed on the notes themselves, so
     * indexing them would return the same note twice under a URL that is not
     * its own. `data-pagefind-body` is site-wide sticky, so this is what
     * enforces it — one stray attribute on a listing template and the whole
     * decision quietly reverses.
     */
    // Anchored on a path separator, not a prefix: a note legitimately slugged
    // `tags-and-folders` builds `tags-and-folders/index.html`, which a bare
    // `^tags` would have failed this check over.
    const listings = indexed.filter((p) => /^(?:notes|tags)[/\\]/.test(p.file) || p.file === '404.html')
    check(listings.length === 0, 'no listing page is marked as indexable', listings.map((p) => p.file).join(', '))

    /**
     * Reported, not asserted, because it is the number the byte budget
     * deliberately does not charge to a page: none of it is downloaded until a
     * reader opens the modal. Reporting it is what keeps that exclusion honest
     * — the weight is visible, it is just billed to the right event.
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

/* ------------------------------------------------------------ full mode */

const run = (args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn('npx', args, { cwd: ROOT, stdio: 'pipe', ...options })
    let out = ''
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('exit', (code) => resolve({ code, out }))
  })

/**
 * `--full` rebuilds twice, and both rebuilds clear the content-collection
 * stores — the rewritten `jotter.config.ts` below changes the markdown pipeline
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
        `features: { toc: true, backlinks: true, tags: false, themeToggle: false, graph: false, search: false, hoverPreview: false, rss: false }`,
      )
      .replace(/\bnav:\s*'(?:tree|tags|none)'/, `nav: 'none'`)
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
       * merely unread — the flag decides whether the bytes are emitted at all.
       */
      check(previewAttrs.length === 0, 'hoverPreview off emits no data-preview attribute')
      /**
       * The same guarantee, both halves. With `search` off the integration is
       * never registered — so there is no index directory — *and* the markup
       * that would have been indexed is unmarked, rather than marked and
       * unused.
       */
      check(searchIndex === null, 'search off writes no dist/pagefind/')
      check(searchAttrs.length === 0, 'search off emits no data-pagefind-body attribute')
      check(
        inline.length === 0 && offJs.length === 0,
        'no JavaScript at all when every scripted feature and the nav are off',
        `${inline.length} inline block(s), ${offJs.length} file(s)`,
      )
    }

    await writeFile(configPath, original)
    await clearContentStores(ROOT)
  }

  /**
   * At whatever `jotter.config.ts` currently says, which is the honest thing
   * for it to do: a forker running this gets their own feature set measured.
   *
   * On the committed default that means **search is off here**, so Pagefind's
   * indexing time is not in the 60s number below. Measured by hand once, at
   * this same 1,000-note vault: 597ms to index and 380ms to write, so about
   * **1.0s**, against a 60s envelope — 1.7%, and it does not grow with the
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
if (warnings) console.log(`${warnings} warning(s).`)
if (failures) {
  console.error(`${failures} check(s) failed.`)
  process.exit(1)
}
console.log(FULL ? 'All checks passed, including the full suite.' : 'All checks passed.')
