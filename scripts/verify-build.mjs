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

  /** The chunks a page really downloads: the ones it names, plus their imports. */
  const closure = (entries) => {
    const seen = new Set()
    const queue = [...entries]
    while (queue.length > 0) {
      const url = queue.pop()
      // A specifier that resolves to nothing in `dist/` is not ours to explain
      // — a bare module name, or a string that only looked like a path.
      if (seen.has(url) || !chunks.has(url)) continue
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
   * Fixing the metric deliberately does *not* move the ceiling. It buys about
   * 20 KB of apparent headroom on most pages, and that headroom is not a
   * budget increase — it was never spent.
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
   * 24 KB, and it stays there. Worth knowing while reading a number close to
   * its ceiling: Astro inlines a script chunk under **4096 bytes** into the
   * page rather than emitting a `.js` file, so a small island never becomes a
   * shared chunk at all — and an island that later crosses 4 KB flips to one,
   * which is a discontinuous jump rather than a gradual one.
   */
  check(worst.bytes < 24 * 1024, 'a page ships under 24 KB of JavaScript', `${worst.bytes} bytes on ${worst.file}`)

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

  if (chunks.size > 0) {
    pass(
      'shared chunks',
      [...loadedBy]
        .map(([url, n]) => `${chunks.get(url).file} ${chunks.get(url).bytes}B on ${n}/${pages.length} page(s)`)
        .join('; '),
    )
  }
  const orphans = [...loadedBy].filter(([, n]) => n === 0).map(([url]) => chunks.get(url).file)
  check(orphans.length === 0, 'every emitted chunk is referenced by a page', orphans.join(', '))

  /**
   * Nothing here should be reaching the network at runtime — and that has to
   * be asserted over the bundled files as well as the inline blocks. Until the
   * graph there were no `.js` files at all in `dist/`, so grepping inline
   * bodies covered everything; the moment client code moves into
   * `dist/_astro/*.js` an inline-only grep would police nothing and still pass.
   */
  const NETWORK = /\bfetch\(|XMLHttpRequest|new WebSocket|navigator\.sendBeacon|EventSource\(/
  const fetches = [...scripts, ...chunks.values()].filter((s) => NETWORK.test(s.body))
  check(fetches.length === 0, 'no runtime network requests', fetches.map((s) => s.file).join(', '))
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

      check(themeCode.length === 0, 'themeToggle off removes its inline script entirely')
      check(tagChips.length === 0, 'tags off removes every tag chip')
      /**
       * The markup half of the guarantee the no-JavaScript check makes below.
       * With `hoverPreview` off the excerpts are *absent* from the anchors, not
       * merely unread — the flag decides whether the bytes are emitted at all.
       */
      check(previewAttrs.length === 0, 'hoverPreview off emits no data-preview attribute')
      check(
        inline.length === 0 && offJs.length === 0,
        'no JavaScript at all when every scripted feature and the nav are off',
        `${inline.length} inline block(s), ${offJs.length} file(s)`,
      )
    }

    await writeFile(configPath, original)
    await clearContentStores(ROOT)
  }

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
