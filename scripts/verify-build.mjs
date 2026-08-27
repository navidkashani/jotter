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

/**
 * Every text output in `dist/`, not only the pages.
 *
 * `pages` is `.html` and nothing else, which was invisible for as long as HTML
 * was all jotter emitted that carried a note's *words*. The feed ends that: it
 * carries titles and excerpts, it is published to the world, and a publish-gate
 * check that reads only `pages` would not read one byte of it — while claiming
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
  // Over `outputs`, not `pages`: this is jotter's strongest privacy claim and
  // it should read every file that could carry a title out of the vault.
  const leaked = outputs.filter(({ text }) => text.includes(PRIVATE_TITLE))
  check(leaked.length === 0, 'no unpublished note’s title appears anywhere in dist/', leaked.map((p) => p.file).join(', '))

  const routed = htmlFiles.some((f) => /half-formed/i.test(f))
  check(!routed, 'no unpublished note has a page of its own')

  /**
   * Anchored on the ways a *URL* is written rather than on the slug alone. The
   * name legitimately appears as text in the demo — `Kitchen sink.md` links to
   * `[[Half-formed]]`, which renders as a dead-link span showing the filename
   * the author typed, which is the documented behaviour. What must never appear
   * is a link that resolves to it, and in a feed those are `<link>` and
   * `<guid>` rather than `href=`.
   */
  const linkedTo = outputs.filter(({ text }) =>
    /(?:href="|<link>|<guid[^>]*>)[^"<]*half-formed/i.test(text),
  )
  check(!linkedTo.length, 'nothing links to an unpublished note', linkedTo.map((p) => p.file).join(', '))
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
   * in `dist/` for the chunk walk to find, so it is invisible here — and it was
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
 * external *without* a marker got there some other way — which is exactly what
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
 * config the set of origins is empty and every check below is vacuously true —
 * so without that second pass, deleting this whole section would change
 * nothing, and an assertion that cannot fail is not an assertion.
 */
function thirdPartyOrigins(pages) {
  const REMOTE = /^(?:https?:)?\/\//i
  const originOf = (url) => new URL(url.startsWith('//') ? `https:${url}` : url).origin

  const tagsOf = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => m[0])
  const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? ''
  const has = (tag, name) => new RegExp(`\\b${name}(?=[\\s>=])`).test(tag)

  /**
   * `src/integrations/vault.ts` copies every non-markdown file in the vault to
   * `dist/_vault/`, with no extension allowlist — so an `.html` attachment a
   * note links to is in `pages` and is *not* jotter's markup. Failing over a
   * `<script src>` in a file the user put in their own vault would be this
   * check inventing a bug.
   *
   * Named separately from the Pagefind exemption above rather than shared with
   * it. They exempt different things for different reasons — that one exempts a
   * directory of code from *fetching*, this one exempts a directory of user
   * files from being read as *jotter's markup* — and one shared predicate would
   * let a single future edit widen both at once.
   */
  const authoredPage = ({ file }) => !file.startsWith(`_vault${sep}`)
  const authored = pages.filter(authoredPage)

  /**
   * Only the attributes that actually *fetch*. `<a href>` is deliberately not
   * here — a link to another site is not a request, and the demo garden is full
   * of them — and neither is `<link rel="canonical">` or `<meta og:url>`, which
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

  const external = authored.flatMap(({ file, html }) =>
    subresources(html).map((url) => ({ file, url, origin: originOf(url) })),
  )

  /** Every external `<script>`, marked or not — the set the marker rule polices. */
  const externalScripts = authored.flatMap(({ file, html }) =>
    tagsOf(html, 'script')
      .filter((tag) => REMOTE.test(attr(tag, 'src')))
      .map((tag) => ({ file, tag, provider: attr(tag, 'data-jotter-analytics') })),
  )

  const unmarked = externalScripts.filter((s) => !s.provider)
  check(
    unmarked.length === 0,
    'every external script in dist/ is one jotter emitted',
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
    'a page talks to at most one origin that is not its own',
    origins.join(', '),
  )

  const providers = [...new Set(externalScripts.map((s) => s.provider))]

  if (providers.length === 0) {
    pass('no third-party origin in dist/', 'analytics.provider is none')
    /**
     * The markup half, and the reason it is asserted separately: `provider:
     * 'none'` must emit *nothing at all* — not an empty tag, not a disabled
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
     * not used and `=== id` is not possible — the verifier never reads the id —
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

/* -------------------------------------------------------------------- feed */

/**
 * A minimal XML well-formedness scan, hand-rolled.
 *
 * Node ships no XML parser and the feed takes no dependency to concatenate
 * forty lines of markup, so this is deliberately narrow: it is aimed at the two
 * ways a *generated* feed actually breaks — a tag that never closes, and an
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
   * jotter's markup — the same exemption `thirdPartyOrigins` names, for the
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
     * Off means absent in *both* halves — no file, and no page advertising one
     * — which is the pairing `search off writes no dist/pagefind/` already
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
   * A relative link in a feed resolves against nothing — the reader has no
   * document to resolve it in — and an off-origin one is a leak or a mistake.
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
   * routes one of them and the other gets no page at all — a site-wide bug the
   * feed does not cause and cannot fix, but can at least name.
   */
  const guids = items.map((body) => value(body, 'guid'))
  const duplicated = [...new Set(guids.filter((g, i) => guids.indexOf(g) !== i))]
  check(
    duplicated.length === 0,
    'every guid is unique, so no item is deduped away by a reader',
    duplicated.length
      ? `${duplicated.join(', ')} — two notes claim the same URL; check whether \`homepage:\` names a note while the vault also has an index note`
      : '',
  )
  check(guidless.length === 0, 'every guid states isPermaLink rather than trusting the default', guidless.join(', '))
  check(badPub.length === 0, 'every <pubDate> is RFC-822', badPub.join('\n        '))
  check(badUpdated.length === 0, 'every <atom:updated> is RFC-3339', badUpdated.join('\n        '))

  /**
   * The check that catches the two date elements being wired to the same value,
   * which no format test can see: both would still parse, and the feed would
   * still validate. The demo garden has notes with distinct `created:` and
   * `updated:` frontmatter, so at least one item must differ — and if that ever
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
      /**
       * `analytics` is a *sibling* of `features`, so the rewrite above could
       * never reach it: a forker with a provider configured would fail the "no
       * JavaScript at all" check below through no fault of their own, and the
       * detail line would send them hunting for an inline script that does not
       * exist. A no-op on the committed config, which has no analytics key.
       *
       * The `provider:` token rather than an `analytics:\s*\{[^}]*\}` block:
       * the block form stops at the first `}`, so a comment or a nested value
       * inside the object would produce a syntax error — and a syntax error
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
      /**
       * The only place `provider: 'none'` emitting nothing is asserted against
       * a real build — the main pass above cannot check it for a forker who
       * does have a provider configured. The analytics counterpart of `search
       * off writes no dist/pagefind/`.
       */
      const offExternal = offPages.filter((html) => /<script\b[^>]*\bsrc="(?:https?:)?\/\//.test(html))
      check(offExternal.length === 0, 'analytics off loads no third-party script', `${offExternal.length} page(s)`)

      /**
       * Counted apart, because an external tag has an empty body and would
       * otherwise be reported as an "inline block" — which is a true statement
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
   * The alternative — turning analytics *on* in the committed
   * `jotter.config.ts` the way `graph` and `search` are on — is the wrong way
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
   * even be turned on — the schema refuses the pair — and every check in that
   * section is vacuously true. Turning the feed on in the committed
   * `jotter.config.ts` is the wrong way to fix that for the same reason
   * analytics is left off: `url` is a claim about where the site lives, and a
   * demo build that asserts `https://example.com` into its own canonical links
   * and sitemap is a demo build lying about itself. A throwaway rebuild costs
   * one `astro build` and touches nobody.
   *
   * `url` is the third top-level key these rewrites reach, and the first that
   * is *commented out* rather than set — so turning the feed on means
   * uncommenting a line, not replacing a value.
   */
  section('RSS on emits a feed every page advertises')
  {
    const configPath = join(ROOT, 'jotter.config.ts')
    const original = await readFile(configPath, 'utf8')

    /**
     * `export default defineConfig({`, not `defineConfig({`. The docstring at
     * the top of `jotter.config.ts` contains the words *`defineConfig({})`
     * builds a working site* — so the shorter anchor matches a **comment**
     * first, and a non-global `replace` would insert the key there and nowhere
     * else. Caught by the guard below rather than shipped, but a guard firing
     * on a config nobody mistyped is a guard nobody trusts.
     */
    const CALL = /export default defineConfig\(\{/
    let on = original
    if (/^\s*url:\s*'/m.test(original)) {
      // Already set — a forker's own URL is better than ours, and leaving it
      // means the origin assertions run against what they actually ship.
    } else if (/^\s*\/\/\s*url:\s*'/m.test(original)) {
      on = on.replace(/^(\s*)\/\/\s*(url:\s*'[^']*',)/m, '$1$2')
    } else {
      on = on.replace(CALL, `export default defineConfig({\n  url: 'https://example.com',`)
    }
    /**
     * Three cases, because `features` is not a key every config has: the README
     * documents `defineConfig({})` as a complete config, and one written that
     * way has no `features:` block to insert `rss` into.
     */
    if (/\brss:\s*(?:true|false)/.test(on)) {
      on = on.replace(/\brss:\s*(?:true|false)/, 'rss: true')
    } else if (/\bfeatures:\s*\{/.test(on)) {
      on = on.replace(/\bfeatures:\s*\{/, 'features: {\n    rss: true,')
    } else {
      on = on.replace(CALL, `export default defineConfig({\n  features: { rss: true },`)
    }

    /**
     * The `unrewritten` guard, extended to a third key. It exists precisely so
     * a regex that misses fails loudly instead of running the feed assertions
     * against a build with no feed in it — where every one of them would pass
     * for the wrong reason.
     */
    const unrewritten = [
      [/^\s*url:\s*'https?:\/\//m, 'url'],
      [/\brss:\s*true/, 'features.rss'],
    ]
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
