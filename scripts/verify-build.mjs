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
import { join, relative, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

import { readTokens, contrastOklch } from './lib/color.mjs'
import { runningDevServers, devServerWarning } from './lib/dev-server.mjs'

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
  const scripts = pages.flatMap(({ file, html }) =>
    [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => ({ file, body: m[1] })),
  )
  const jsFiles = await walk(DIST, (n) => n.endsWith('.js'))
  const sharedBytes = (await Promise.all(jsFiles.map(async (f) => (await stat(f)).size))).reduce(
    (a, b) => a + b,
    0,
  )

  /**
   * Budget per *page*, not across the site: the inline blocks are counted one
   * page at a time rather than summed, so this measures what a reader
   * downloads instead of how many notes the demo has.
   *
   * `sharedBytes` is the honest caveat. It totals *every* `.js` in `dist/` and
   * charges that total to every page, so the graph chunk only note pages load
   * is billed to the tag index too. Deliberately left alone: attributing it
   * properly means walking each page's module graph, and over-charging is the
   * safe direction for a budget to be wrong in.
   */
  const perPage = pages.map(({ file, html }) => ({
    file,
    bytes:
      [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].reduce(
        (n, m) => n + Buffer.byteLength(m[1]),
        0,
      ) + sharedBytes,
  }))
  const worst = perPage.reduce((a, b) => (a.bytes >= b.bytes ? a : b), { file: '-', bytes: 0 })

  pass(
    'JavaScript per page',
    `${worst.bytes} bytes at worst (${worst.file}); ${jsFiles.length} shared file(s), ${scripts.length} inline block(s) site-wide`,
  )
  check(worst.bytes < 24 * 1024, 'a page ships under 24 KB of JavaScript', `${worst.bytes} bytes on ${worst.file}`)

  /**
   * Nothing here should be reaching the network at runtime — and that has to
   * be asserted over the bundled files as well as the inline blocks. Until the
   * graph there were no `.js` files at all in `dist/`, so grepping inline
   * bodies covered everything; the moment client code moves into
   * `dist/_astro/*.js` an inline-only grep would police nothing and still pass.
   */
  const bundled = await Promise.all(
    jsFiles.map(async (f) => ({ file: relative(DIST, f), body: await readFile(f, 'utf8') })),
  )
  const NETWORK = /\bfetch\(|XMLHttpRequest|new WebSocket|navigator\.sendBeacon|EventSource\(/
  const fetches = [...scripts, ...bundled].filter((s) => NETWORK.test(s.body))
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
 * `--full` rebuilds twice, and both rebuilds clear `node_modules/.astro`. It
 * also rewrites `jotter.config.ts` for the duration of the feature-flag pass.
 * Neither is survivable by a dev server reading the same files, so it refuses
 * for the same reason `npm run clean` does.
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
    await rm(join(ROOT, 'node_modules', '.astro'), { recursive: true, force: true })

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

      check(themeCode.length === 0, 'themeToggle off removes its inline script entirely')
      check(tagChips.length === 0, 'tags off removes every tag chip')
      check(
        inline.length === 0 && offJs.length === 0,
        'no JavaScript at all when every scripted feature and the nav are off',
        `${inline.length} inline block(s), ${offJs.length} file(s)`,
      )
    }

    await writeFile(configPath, original)
    await rm(join(ROOT, 'node_modules', '.astro'), { recursive: true, force: true })
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
    await rm(join(ROOT, 'node_modules', '.astro'), { recursive: true, force: true })
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
