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
 *   npm run verify   the checks below, over the current dist/
 *
 * **Everything here reads `dist/` and nothing else.** It builds nothing,
 * rewrites nothing and needs no fixture, which is what makes it safe to leave
 * in `npm run build` on somebody else's site. The passes that rebuild this
 * repository under configurations nobody ships live in
 * `scripts/verify-theme.mjs` and never run on a user's site; see the docstring
 * in `scripts/lib/verify.mjs` for why the two are separate files.
 *
 * The vocabulary — `check`, `observe`, `demo`, and which of them stops a
 * deploy — is defined there too.
 */
import { readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { readTokens, contrastOklch } from './lib/color.mjs'
import {
  DEMO,
  DIST,
  ROOT,
  byRegion,
  check,
  demo,
  directionSection,
  feedSection,
  internalLinks,
  note,
  observe,
  pass,
  producersAgree,
  proseOf,
  readDist,
  redirectsAndRobots,
  routeOf,
  section,
  skip,
  socialCards,
  summary,
  thirdPartyOrigins,
  walk,
} from './lib/verify.mjs'

const { htmlFiles, pages, outputs, authored } = await readDist()

console.log(`Verifying ${pages.length} page(s) in dist/`)
console.log(
  DEMO
    ? "  as this repository's own demo garden, because JOTTER_DEMO is set"
    : '  as a site built from a vault',
)
console.log('')
console.log('  FAIL  a claim jotter guarantees about every site is broken. The build stops.')
console.log('  note  something true of this site\u2019s own content. The build carries on.')
if (!DEMO) console.log('  skip  a guard on this repository\u2019s demo fixtures, which this build is not.')
console.log('')

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
    /**
     * `src/user/` is exempt for the same reason `custom.css` is, one directory
     * over: everything in it is somebody's own component, replacing one of
     * jotter's. A `padding-left` in a header a reader wrote themselves is their
     * call about their own site, and failing a deploy over it is exactly the
     * kind of misfire that teaches people to delete this script.
     */
    if (name.startsWith(`src${sep}user${sep}`)) continue
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
   * target `scripts/verify-theme.mjs` asserts against.
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

section('Feed')
await feedSection(pages)

section('Social cards')
await socialCards(pages)

summary('All checks passed.')
