import { describe, expect, it } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { markdownToHtml } from 'satteri'

import { scanVault, clearVaultCache } from '../src/lib/vault.js'
import { defineConfig, type JotterConfigInput } from '../src/lib/config.js'
import { jotterPlugins, jotterHastPlugins, satteriFeatures } from '../src/markdown/index.js'
import { parseEmbedsIndex } from '../src/lib/embeds-index.js'

const VAULT = fileURLToPath(new URL('./fixtures/vault', import.meta.url))

/**
 * Compile a note exactly the way the Astro build will.
 *
 * `embeds` stands in for `.jotter/embeds.json`, which only an Open Publish
 * build writes: it is what a build with a network downloaded, and the fixture
 * vault has none, so the default here is the degraded state every other test
 * sees.
 */
function render(
  notePath: string,
  overrides: JotterConfigInput = {},
  embeds?: Record<string, Record<string, unknown>>,
): string {
  clearVaultCache()
  const vault = scanVault({ root: VAULT })
  const config = defineConfig({ vault: VAULT, ...overrides })
  if (embeds) {
    const index = parseEmbedsIndex(JSON.stringify({ embeds }))
    vault.embeds = index
  }
  const note = vault.byPath.get(notePath.toLowerCase())
  if (!note) throw new Error(`fixture missing: ${notePath}`)

  const result = markdownToHtml(note.body, {
    features: satteriFeatures,
    mdastPlugins: jotterPlugins(vault, config),
    hastPlugins: jotterHastPlugins(vault, config),
    fileURL: pathToFileURL(join(VAULT, note.path)),
  })
  return typeof result === 'string' ? result : (result as { html: string }).html
}

describe('wikilink resolution', () => {
  const html = render('Zettelkasten.md')

  it('turns a resolved wikilink into a real link', () => {
    expect(html).toMatch(/<a href="\/notes\/luhmann">Luhmann<\/a>/)
  })

  it('renders an unpublished target as an inert span, not an anchor', () => {
    expect(html).toContain('class="dead-link"')
    expect(html).not.toMatch(/<a[^>]*href="[^"]*secret/i)
  })

  it('never leaks an unpublished note title', () => {
    expect(html).not.toContain('My Very Private Title')
    expect(html).toContain('the private one') // the alias the author wrote
  })

  it('renders an unresolved link as an inert span labelled by its target', () => {
    expect(html).toMatch(/<span class="dead-link">Nothing At All<\/span>/)
  })

  it('emits no anchor with an empty or undefined href', () => {
    expect(html).not.toMatch(/<a[^>]+href=""/)
    expect(html).not.toMatch(/href="undefined"/)
    expect(html).not.toMatch(/<span[^>]+href=/)
  })

  it('leaves wikilinks inside a code fence and inline code literal', () => {
    expect(html).toContain('[[Luhmann]] inside a fence stays literal')
    expect(html).toContain('[[AlsoLiteral]]')
  })

  it('labels a dead link with the basename, not the written path', () => {
    const bare = render('Home.md')
    expect(bare).toMatch(/<span class="dead-link">Secret Log<\/span>/)
  })
})

describe('embeds', () => {
  const html = render('Zettelkasten.md')

  it('resolves an image embed to the attachment', () => {
    expect(html).toMatch(/<img[^>]+src="[^"]*diagram\.png"/)
  })

  it('reads a numeric pipe as a width', () => {
    expect(html).toMatch(/<img[^>]+width="300"/)
  })

  it('reads a non-numeric pipe as a caption and builds a figure', () => {
    expect(html).toContain('<figure class="embed-figure">')
    expect(html).toContain('<figcaption>A caption here</figcaption>')
  })

  it('never puts a block element inside a paragraph', () => {
    // An open <p> with no </p> before it would be invalid nesting, which Astro
    // 7's compiler no longer silently repairs. The document embed is why <div>
    // is on the list beside <figure>: it wraps two phrasing-content children
    // and is a <span> for exactly this reason.
    expect(html).not.toMatch(/<p>(?:(?!<\/p>)[\s\S])*?<(?:figure|div)[\s>]/)
  })

  /**
   * Every one of these used to be an `<img>`. Four of the five render as a
   * broken-image icon in every browser there is, and the fifth, the PDF, was
   * what let the build assertion "the demo actually renders images" pass while
   * the page showed nothing.
   */
  it('embeds a PDF in a frame with a link beside it', () => {
    expect(html).toContain(
      '<span class="doc-embed"><iframe class="doc-frame" src="/_vault/attachments/paper.pdf"' +
        ' title="paper.pdf" loading="lazy"></iframe>' +
        '<a class="file-embed" href="/_vault/attachments/paper.pdf" data-file="pdf">paper.pdf</a></span>',
    )
    expect(html).not.toMatch(/<img[^>]+\.pdf/)
  })

  /**
   * The bang is the author's own answer to embed-or-link, and it is the whole
   * reason both of these exist: `![[…]]` is an inline viewer in Obsidian and
   * `[[…]]` is a link, so jotter must not collapse them into one.
   */
  it('links a PDF written without the bang, and frames nothing', () => {
    const link = html.split('\n').find((line) => line.includes('<a href="/_vault/attachments/paper.pdf"'))
    expect(link).toBe(
      '<p><a href="/_vault/attachments/paper.pdf" class="file-embed" data-file="pdf">paper.pdf</a></p>',
    )
    expect(link).not.toContain('<iframe')
  })

  it('passes an Obsidian #page fragment through to the frame src', () => {
    expect(html).toContain('<iframe class="doc-frame" src="/_vault/attachments/paper.pdf#page=3"')
  })

  it('reads an Obsidian #height fragment as the frame height, not as part of the src', () => {
    expect(html).toContain(
      '<iframe class="doc-frame" src="/_vault/attachments/paper.pdf" title="paper.pdf"' +
        ' loading="lazy" height="400">',
    )
    expect(html).not.toContain('paper.pdf#height')
  })

  it('gives a captioned PDF its own name on the card and the caption below', () => {
    expect(html).toContain(
      '<figure class="embed-figure"><span class="doc-embed"><iframe class="doc-frame"' +
        ' src="/_vault/attachments/paper.pdf" title="paper.pdf" loading="lazy"></iframe>' +
        '<a class="file-embed" href="/_vault/attachments/paper.pdf" data-file="pdf">paper.pdf</a>' +
        '</span><figcaption>The paper itself</figcaption></figure>',
    )
  })

  /** Every embedded document ships the link that a blank frame needs. */
  it('never emits a frame without a link to the same file beside it', () => {
    const frames = [...html.matchAll(/<iframe[^>]+src="([^"#?]+)/g)].map(([, src]) => src)
    expect(frames.length).toBeGreaterThan(0)
    for (const src of frames) expect(html).toContain(`<a class="file-embed" href="${src}"`)
  })

  it('gives video and audio their own players, preloading only metadata', () => {
    expect(html).toContain('<video src="/_vault/attachments/clip.mp4" controls preload="metadata">')
    expect(html).toContain('<audio src="/_vault/attachments/sound.mp3" controls preload="metadata">')
    expect(html).not.toMatch(/<img[^>]+\.(?:mp4|mp3)/)
  })

  /**
   * The regression the rest of this block is about, stated once over the whole
   * page rather than per format: whatever an `<img>` points at, it is a picture.
   */
  it('points no <img> at a target that is not an image', () => {
    for (const [, src] of html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)) {
      expect(src).not.toMatch(/\.(?:pdf|mp4|webm|mov|ogv|mp3|wav|m4a|ogg|flac)(?:[?#]|$)/i)
    }
  })

  it('cards a remote embed that names no image, rather than fetching it', () => {
    // `![](https://open.spotify.com/…)` is an address, not a picture. An <img>
    // of it is a broken icon; an <iframe> of it would put another origin in the
    // page. The card names the host and the path, without the tracking query
    // the raw URL used to be labelled with.
    expect(html).toContain(
      '<a class="embed-card" href="https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc123"' +
        ' rel="noopener" target="_blank">' +
        '<span class="embed-card-host">open.spotify.com</span>' +
        '<span class="embed-card-path">/track/4cOdK2wGLETKBW3PvgPWqT</span></a>',
    )
    expect(html).not.toMatch(/<img[^>]+spotify/)
  })

  it('still renders a remote embed that does name an image', () => {
    expect(html).toContain('<img src="https://cdn.example.com/photo.png" alt="">')
  })
})

/**
 * The whole claim, in one describe: Obsidian shows a player, jotter shows the
 * same frame, and the page has still asked nobody for anything.
 */
describe('click-to-play embeds', () => {
  const html = render('Zettelkasten.md')

  it('renders a video as a facade with no cross-origin frame in the markup', () => {
    expect(html).toContain('<span class="video-embed" data-embed="youtube" data-embed-id="dQw4w9WgXcQ">')
    // The note embeds a PDF too, so the claim is about *whose* frame it is: the
    // only `<iframe>` here is jotter's own, pointing at this site's `/_vault/`.
    const frames = [...html.matchAll(/<iframe\b[^>]*\bsrc="([^"]*)"/g)].map(([, src]) => src)
    expect(frames.length).toBeGreaterThan(0)
    for (const src of frames) expect(src.startsWith('/')).toBe(true)
    expect(html).not.toContain('youtube-nocookie')
  })

  /**
   * The facade *is* its own noscript answer: one `<a>` to the video, upgraded
   * by `src/scripts/embed.ts` on click. Nothing here depends on that script
   * having run, or having loaded at all.
   */
  it('is a working link to the video before any script runs', () => {
    expect(html).toContain('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
    expect(html).toContain('class="video-embed-link"')
    expect(html).toContain('Play on YouTube')
  })

  /**
   * The poster is the reason `lite-youtube-embed` could not be used: it fetches
   * its thumbnail from `i.ytimg.com` at runtime, which is the request jotter's
   * origin assertion forbids. Downloaded at build time, it is a local file.
   */
  it('serves the poster from this site, with its box reserved', () => {
    const withPoster = render('Zettelkasten.md', {}, {
      'youtube:dQw4w9WgXcQ': {
        poster: 'attachments/embeds/youtube-dQw4w9WgXcQ.jpg',
        width: 1280,
        height: 720,
      },
    })
    expect(withPoster).toContain(
      '<img class="video-embed-poster" src="/_vault/attachments/embeds/youtube-dQw4w9WgXcQ.jpg"' +
        ' alt="" width="1280" height="720" loading="lazy" decoding="async">',
    )
    expect(withPoster).not.toContain('ytimg.com')
  })

  it('keeps whatever the author called the video, and names it when they did not', () => {
    expect(html).toContain('<span class="video-embed-label">Never Gonna Give You Up<span')
    expect(html).toContain('<span class="video-embed-label">Play on YouTube<span')
  })

  it('degrades to a poster-less facade rather than a broken image', () => {
    // No index, or a video whose thumbnail 404s: the box and the link stay.
    expect(html).toContain('class="video-embed"')
    expect(html).not.toContain('video-embed-poster')
  })

  /**
   * A tweet is real text or a link, never invented text. Without a fetched
   * record there is nothing honest to render but the address.
   */
  it('cards a tweet the build could not fetch', () => {
    expect(html).toContain('<span class="embed-card-host">twitter.com</span>')
    expect(html).not.toContain('tweet-embed')
  })

  it('renders a fetched tweet as jotter’s own markup, not X’s', () => {
    const withTweet = render('Zettelkasten.md', {}, {
      'tweet:1834417901081694320': {
        text: 'A thing somebody said.',
        author: 'Someone',
        handle: '@someone',
        date: 'September 13, 2024',
      },
    })
    expect(withTweet).toContain('<span class="tweet-embed-text">A thing somebody said.</span>')
    expect(withTweet).toContain('Someone @someone')
    expect(withTweet).toContain('<span class="tweet-embed-date">September 13, 2024</span>')
    // Nothing of X's: no blockquote class, no script, no widget stylesheet.
    expect(withTweet).not.toContain('twitter-tweet')
    expect(withTweet).not.toContain('platform.twitter.com')
  })

  it('falls back to the link card it always was with embeds off', () => {
    const off = render('Zettelkasten.md', { features: { embeds: false } })
    expect(off).not.toContain('video-embed')
    expect(off).toContain('<span class="embed-card-host">youtu.be</span>')
  })
})

describe('callouts', () => {
  const html = render('Zettelkasten.md')

  it('renders a plain callout with its type and title', () => {
    expect(html).toMatch(/<div class="callout" data-callout="note">/)
    expect(html).toContain('<div class="callout-title">A callout</div>')
    expect(html).toContain('With a body.')
  })

  it('renders a collapsible callout as details/summary', () => {
    expect(html).toMatch(/<details class="callout" data-callout="warning">/)
    expect(html).toContain('<summary class="callout-title">Collapsed</summary>')
    expect(html).not.toMatch(/<details[^>]+open/)
  })

  it('leaves an ordinary blockquote alone', () => {
    const out = compile('> just a quote')
    expect(out).toContain('<blockquote>')
    expect(out).not.toContain('callout')
  })
})

describe('inline syntaxes', () => {
  const html = render('Zettelkasten.md')

  it('renders a highlight as mark', () => {
    expect(html).toContain('<mark>important</mark>')
  })

  it('strips comments', () => {
    expect(html).not.toContain('but not this comment')
    expect(html).not.toContain('%%')
  })

  it('links inline tags to their tag page', () => {
    expect(html).toMatch(/<a class="tag-chip" href="\/tags\/method\/zettelkasten"[^>]*>#method\/zettelkasten<\/a>/)
  })

  it('turns a soft newline into a break by default', () => {
    expect(html).toContain('<br>')
  })

  it('keeps soft newlines as whitespace under strictLineBreaks', () => {
    expect(render('Zettelkasten.md', { strictLineBreaks: true })).not.toContain('<br>')
  })

  it('never makes a tag chip out of text in a code fence', () => {
    expect(html).not.toMatch(/tag-chip[^>]*>#AlsoLiteral/)
  })
})

describe('transclusion', () => {
  it('inlines a target inside an aside that links back to it', () => {
    const html = render('cycles/A.md')
    expect(html).toContain('class="transclusion"')
    expect(html).toMatch(/<a class="transclusion-source" href="\/cycles\/b">B<\/a>/)
  })

  it('stops at a cycle instead of recursing', () => {
    const html = render('cycles/A.md')
    expect(html).toContain('data-transclusion="cycle"')
    expect(html).toContain('already open above')
  })

  it('stops at the configured depth', () => {
    const html = render('cycles/A.md', { transcludeDepth: 0 })
    expect(html).toContain('data-transclusion="depth"')
  })
})

describe('whitespace around inline elements (the compressHTML: jsx trap)', () => {
  it('keeps the space between a word and a following link', () => {
    const out = compile('Invented by [[Luhmann]] in Bielefeld.')
    expect(out).toContain('by <a')
    expect(out).toContain('</a> in')
  })

  it('keeps the space around emphasis next to a link', () => {
    const out = compile('An *emphasised* [[Luhmann]] word.')
    expect(out).toMatch(/<em>emphasised<\/em> <a/)
  })
})

/** Compile an arbitrary snippet as though it were a note at the vault root. */
function compile(markdown: string, overrides: JotterConfigInput = {}): string {
  clearVaultCache()
  const vault = scanVault({ root: VAULT })
  const config = defineConfig({ vault: VAULT, ...overrides })
  const result = markdownToHtml(markdown, {
    features: satteriFeatures,
    mdastPlugins: jotterPlugins(vault, config),
    fileURL: pathToFileURL(join(VAULT, 'Zettelkasten.md')),
  })
  return typeof result === 'string' ? result : (result as { html: string }).html
}

/**
 * The build-time half is unit-tested in `lib.test.ts`; this is the half that
 * only shows up in finished HTML, which anchors get the attributes, and which
 * emphatically do not.
 */
describe('links that leave the site', () => {
  const html = render('Previews.md')

  it('carries the class, the rel and the new tab', () => {
    expect(html).toContain(
      '<a href="https://example.com" class="external-link" rel="noopener" target="_blank">',
    )
  })

  /**
   * WCAG G201 wants the warning in advance and SC 1.1.1 says an icon is not
   * one, so the sentence is in the markup. Obsidian Publish ships the glyph
   * alone; that is a bug in Obsidian Publish, not a spec to copy.
   */
  it('warns a screen reader in words, not only with a glyph', () => {
    expect(html).toContain('<span class="visually-hidden"> (opens in a new tab)</span>')
  })

  /**
   * Obsidian Publish nofollows every outbound link. On a knowledge garden those
   * links are editorial citations, and nofollowing them withholds credit from
   * the sources the author is recommending.
   */
  it('never nofollows a citation', () => {
    expect(html).not.toContain('nofollow')
  })

  it('treats a protocol-relative URL as what it is: somebody else’s host', () => {
    expect(html).toMatch(/<a href="\/\/example\.com\/notes\/luhmann"[^>]*class="external-link"/)
  })

  /**
   * A scheme is not a page. "Opens in a new tab" is a false promise about a
   * mail client, and an arrow beside an address says nothing new.
   */
  it('leaves mailto and same-page anchors exactly as they were', () => {
    expect(html).toContain('<a href="mailto:someone@example.com">')
    expect(html).toContain('<a href="#previews">')
  })

  it('leaves an internal link alone', () => {
    expect(html).toContain('<a href="/sections">')
    expect(html).not.toMatch(/<a href="\/sections"[^>]*target/)
  })

  it('drops the class rather than hiding the glyph when the icon is off', () => {
    const noIcon = render('Previews.md', { externalLinks: { icon: false } })
    expect(noIcon).toContain('<a href="https://example.com" rel="noopener" target="_blank">')
    expect(noIcon).not.toContain('external-link')
    // The rel and the warning are independent of the decoration.
    expect(noIcon).toContain('(opens in a new tab)')
  })

  it('drops the target and its warning together when the new tab is off', () => {
    const sameTab = render('Previews.md', { externalLinks: { newTab: false } })
    expect(sameTab).toContain('<a href="https://example.com" class="external-link" rel="noopener">')
    expect(sameTab).not.toContain('opens in a new tab')
    // `rel="noopener"` stays: it is not the new tab's to own.
    expect(sameTab).toContain('rel="noopener"')
  })
})

describe('hover previews', () => {
  const on = { features: { hoverPreview: true } }

  it('ships nothing at all with the flag off', () => {
    expect(render('Previews.md')).not.toContain('data-preview')
  })

  it('puts the target’s title and opening paragraph on a resolved wikilink', () => {
    expect(render('Previews.md', on)).toContain(
      '<a href="/notes/luhmann" data-preview-title="Niklas Luhmann" data-preview="A sociologist. Back to Zettelkasten.">',
    )
  })

  it('previews the section a heading link points at, and names it', () => {
    const html = render('Previews.md', on)
    // `>` needs no escaping inside a double-quoted attribute value, so this
    // reads literally here while the link's own text renders it as `&gt;`.
    expect(html).toContain('data-preview-title="Sections > How it works"')
    expect(html).toContain(
      'data-preview="Each note gets an address, and new notes are filed behind whichever note they answer."',
    )
  })

  it('falls back to the note for a heading that is missing, empty or fenced', () => {
    const html = render('Previews.md', on)
    for (const anchor of ['#nowhere', '#hidden', '#nothing-under-here']) {
      expect(html).toContain(
        `<a href="/sections${anchor}" data-preview-title="Sections" data-preview="The opening of the whole note,`,
      )
    }
  })

  it('never puts an excerpt on a dead link', () => {
    const html = render('Previews.md', on) + render('Zettelkasten.md', on)
    expect(html).toMatch(/class="dead-link"/)
    expect(html).not.toMatch(/<span[^>]*data-preview/)
  })

  /**
   * The regression test that stops the transclusion hole reopening.
   * `preresolveLinks` rewrites a transcluded note's wikilinks to `/slug#anchor`
   * before the host is parsed, so these arrive at the link visitor looking
   * exactly like external ones.
   */
  it('reaches a link that transclusion pre-resolved into an href', () => {
    expect(render('Previews.md', on)).toContain(
      '<a href="/zettelkasten" data-preview-title="Zettelkasten" data-preview="Invented by Luhmann.',
    )
  })

  it('reaches a hand-written internal markdown link out of the same branch', () => {
    expect(render('Previews.md', on)).toContain(
      '<a href="/sections" data-preview-title="Sections" data-preview="The opening of the whole note,',
    )
  })

  /**
   * There is nothing on this site to preview, so neither gets one. They do get
   * the external-link treatment, which is a different visitor's business and
   * asserted under "links that leave the site" above; what matters here is that
   * `//example.com/notes/luhmann` is not mistaken for the local `/notes/luhmann`.
   */
  it('previews no genuinely external link, protocol-relative ones included', () => {
    const html = render('Previews.md', on)
    const external = [...html.matchAll(/<a\b[^>]*href="(?:https?:)?\/\/example\.com[^"]*"[^>]*>/g)]
    expect(external).toHaveLength(2)
    for (const [tag] of external) expect(tag).not.toContain('data-preview')
  })

  /**
   * An inline transclusion is a `link` an earlier plugin already dressed, so
   * the attributes have to merge rather than overwrite. Its sibling, the
   * `.transclusion-source` back-link, is raw HTML and never reaches a visitor
   * at all: that asymmetry is a consequence of how each is built, and it is
   * recorded here rather than discovered later.
   */
  it('merges into an inline transclusion without stripping its class', () => {
    const html = render('Previews.md', on)
    expect(html).toContain('<a class="transclusion-source" href="/notes/luhmann">')
    expect(html).not.toMatch(/<a class="transclusion-source"[^>]*data-preview/)
  })
})

/**
 * Per-block direction, through the real pipeline rather than against
 * `firstStrong` directly. `test/bidi.test.ts` owns the rule; what is asserted
 * here is everything the rule cannot say on its own, which nodes get asked,
 * what each one inherits, and that a block agreeing with its page emits
 * nothing at all.
 */
describe('text direction', () => {
  const ltr = render('notes/Mixed direction.md')
  const rtl = render('notes/Mixed direction.md', { dir: 'rtl' })

  it('marks a Persian paragraph on an English site', () => {
    expect(ltr).toMatch(/<p dir="rtl">اینجا محلی هست/)
  })

  it('marks a Persian heading and a Persian list item', () => {
    expect(ltr).toMatch(/<h2[^>]*\bdir="rtl"/)
    expect(ltr).toMatch(/<li dir="rtl">وبلاگ شخصی<\/li>/)
  })

  /**
   * The claim the whole feature rests on. Not "the English blocks are marked
   * `ltr`": they carry no `dir` at all, which is what makes a monolingual
   * vault byte-identical to a build without any of this.
   */
  it('leaves every English block on an English site completely unmarked', () => {
    expect(ltr).toContain('<p>An English paragraph, on an English site')
    expect(ltr).toContain('<li>An English item in the same list.</li>')
    expect(ltr).not.toContain('dir="ltr"')
  })

  it('marks a table cell, a callout title and a blockquote body', () => {
    expect(ltr).toMatch(/<t[hd] dir="rtl">ابزار<\/t[hd]>/)
    expect(ltr).toMatch(/<div class="callout-title" dir="rtl">یک هشدار فارسی<\/div>/)
  })

  /**
   * The assertion that justifies the hast seam, and the one that goes red if
   * this is ever moved to mdast. Transclusion splices a raw markdown string
   * wrapped in a literal `<aside>`; the aside arrives as a `raw` node and the
   * paragraph inside it does not exist at all while mdast is being walked.
   */
  it('reaches a paragraph that transclusion brought in', () => {
    expect(ltr).toMatch(/<aside class="transclusion"[\s\S]*?<p dir="rtl">این یادداشت به فارسی/)
  })

  it('never repeats a dir a block already inherits from its parent', () => {
    // The Persian blockquote is marked; the paragraph inside it must not be.
    expect(rtl).not.toMatch(/<blockquote dir="ltr">\s*<p dir="ltr">/)
    expect(ltr).not.toMatch(/dir="rtl"[^>]*>\s*<p dir="rtl">/)
  })

  /**
   * The mirror. An RTL site marks the *English*, and its own script goes
   * untouched: one rule, no second code path.
   */
  it('marks the English and leaves the Persian alone on an RTL site', () => {
    expect(rtl).toMatch(/<p dir="ltr">An English paragraph/)
    expect(rtl).toMatch(/<li dir="ltr">An English item in the same list\.<\/li>/)
    expect(rtl).toContain('<p>اینجا محلی هست')
    expect(rtl).not.toContain('dir="rtl"')
  })

  /**
   * `pre` resolves to `ltr` (code is left-to-right and must not be re-ordered)
   * but it is emitted under the same rule as everything else, so it costs an
   * LTR site nothing. Forcing it unconditionally was defect 3 of the plan's
   * scenario pass.
   */
  it('marks a code block only where it differs from the page', () => {
    expect(ltr).not.toMatch(/<pre[^>]*\bdir=/)
    expect(rtl).toMatch(/<pre[^>]*\bdir="ltr"/)
  })

  /** A Persian comment inside a fence is code, not prose, and is never asked. */
  it('never marks anything inside a code fence', () => {
    expect(ltr).not.toMatch(/<code[^>]*\bdir=/)
    expect(ltr).not.toMatch(/<span[^>]*\bdir=/)
  })

  /**
   * The escape hatch, and the case that catches an implementation which only
   * ever emits `rtl`: an RTL note on an LTR site, where it is the *English*
   * blocks that differ.
   */
  describe('the direction: frontmatter override', () => {
    const html = render('notes/English in Persian.md')

    it('flips the note baseline, so only its English blocks are marked', () => {
      expect(html).toContain('<p>این یادداشت به فارسی')
      expect(html).toMatch(/<p dir="ltr">An English paragraph inside an RTL note/)
      expect(html).toMatch(/<h2[^>]*\bdir="ltr"/)
      expect(html).toMatch(/<li dir="ltr">An English list item<\/li>/)
      expect(html).not.toContain('dir="rtl"')
    })

    it('is what the note says, not what the site says', () => {
      // Same note, RTL site: the note already agreed, so nothing changes.
      const onRtlSite = render('notes/English in Persian.md', { dir: 'rtl' })
      expect(onRtlSite).toMatch(/<p dir="ltr">An English paragraph inside an RTL note/)
    })
  })
})
