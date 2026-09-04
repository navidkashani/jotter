#!/usr/bin/env node
/**
 * jotter's own maintenance suite: the passes that rebuild this repository under
 * configurations nobody ships.
 *
 *   npm run verify:full
 *
 * Features off, analytics on, RSS on, a homepage set, Obsidian-style URLs, an
 * Open Publish snapshot fetched from a stand-in bucket, the direction feature
 * mirrored, a vault with none of the demo's fixtures, and a synthetic
 * 1,000-note vault. Nine rebuilds, several of which rewrite `jotter.config.ts`,
 * clear Astro's content stores and write to `tmpdir()`.
 *
 * **This never runs on a user's site, and that is the point of it being a
 * separate file.** Its assertions are about fixtures that exist in this
 * repository's demo garden and nowhere else, so on somebody's vault they fail
 * for reasons that are nobody's fault and cannot be fixed. That already
 * happened: see the docstring in `scripts/lib/verify.mjs`.
 *
 * It assumes a `dist/` from an ordinary build is already there (the `verify:full`
 * script builds one first), because several sections restore the committed
 * config and re-run the dist checks against it.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import { clearContentStores } from './lib/astro-cache.mjs'
import { devServerWarning, runningDevServers } from './lib/dev-server.mjs'
import {
  DIST,
  ROOT,
  TEXT_OUTPUT,
  check,
  decodePath,
  demo,
  directionSection,
  encodePath,
  fail,
  feedSection,
  internalLinks,
  note,
  pageFileFor,
  pass,
  producersAgree,
  redirectsAndRobots,
  run,
  runNode,
  section,
  socialCards,
  summary,
  thirdPartyOrigins,
  walk,
} from './lib/verify.mjs'

console.log('Verifying jotter itself, by rebuilding it.')
console.log('  Nothing below is a claim about a site built from this theme.')
console.log('')

/**
 * Every rebuild below clears the content-collection stores first: the rewritten
 * `jotter.config.ts` changes the markdown pipeline without changing a single
 * source digest, which is the one thing the content layer does not notice. See
 * `lib/astro-cache.mjs`.
 *
 * Neither the config rewrite nor the clearing is survivable by a dev server
 * reading the same files, so it refuses for the same reason `npm run clean`
 * does.
 */
const servers = runningDevServers(ROOT)
if (servers.length > 0) {
  console.error(`\n${devServerWarning(servers, 'npm run verify:full')}`)
  process.exit(1)
}

/**
 * Every section below works by rewriting `jotter.config.ts` and rebuilding.
 * An overlay left behind by an Open Publish build replaces that file's
 * literal outright (`generated ?? { … }`), so with one present every rewrite
 * is a no-op the build never sees, and each section then asserts against a
 * site it did not configure. Refused rather than deleted: `.jotter/` may hold
 * the vault somebody is mid-way through debugging.
 */
if (await stat(join(ROOT, '.jotter', 'site.json')).catch(() => null)) {
  console.error(
    '\n.jotter/site.json is present, so jotter.config.ts is not what this build reads,\n' +
      'and every config rewrite below would be silently ignored.\n\n' +
      '  npm run clean\n',
  )
  process.exit(1)
}

/**
 * Where a key gets inserted into a config source: the opening brace of the
 * hand-written literal, which is now the one after `generated ??`.
 *
 * It has to be that brace and not `defineConfig(`, for two reasons. The
 * docstring at the top of `jotter.config.ts` contains the words
 * *`defineConfig({})` builds a working site*, so a looser anchor matches a
 * **comment** first and a non-global `replace` would insert the key there and
 * nowhere else. And the literal is no longer the argument: `defineConfig`
 * receives `generated ?? { … }`, so a key written just inside the call would
 * be a syntax error rather than a config change.
 *
 * A config with the `generated ??` fallback removed (which is a forker's
 * right: it is their file) matches nothing here, and every rewrite below is
 * covered by an `unrewritten` guard that says so out loud rather than running
 * assertions against a build that was never modified.
 */
const CALL = /generated \?\? \{/

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
    : original.replace(CALL, `generated ?? {\n    ${ANALYTICS_ON},`)

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
    on = on.replace(CALL, `generated ?? {\n    url: 'https://example.com',`)
  }

  if (/\brss:\s*(?:true|false)/.test(on)) {
    on = on.replace(/\brss:\s*(?:true|false)/, 'rss: true')
  } else if (/\bfeatures:\s*\{/.test(on)) {
    on = on.replace(/\bfeatures:\s*\{/, 'features: {\n    rss: true,')
  } else {
    on = on.replace(CALL, `generated ?? {\n    features: { rss: true },`)
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
    : source.replace(CALL, `generated ?? {\n    image: '${SITE_IMAGE}',`)

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
    : original.replace(CALL, `generated ?? {\n    homepage: '${CLAIMANT}',`)

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
      : source.replace(CALL, `generated ?? {\n    slugs: 'obsidian',`)

  /** Search on, so the fourth producer exists to be compared. */
  const withSearchOn = (source) => {
    if (/\bsearch:\s*(?:true|false)/.test(source)) {
      return source.replace(/\bsearch:\s*(?:true|false)/, 'search: true')
    }
    if (/\bfeatures:\s*\{/.test(source)) {
      return source.replace(/\bfeatures:\s*\{/, 'features: {\n    search: true,')
    }
    return source.replace(CALL, `generated ?? {\n    features: { search: true },`)
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
  /** Everything the fetch generates, and the only thing it is allowed to write. */
  const overlayDir = join(ROOT, '.jotter')
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
        'the build says out loud which options it regenerated',
      )
      /**
       * The claim the whole update story rests on, asserted where it is
       * cheapest to assert: a fetch touches **nothing tracked**. It used to
       * rewrite `jotter.config.ts`, a file the README names as a forker's own,
       * so every build handed back a dirty tree and every upstream change to
       * that path became a conflict.
       */
      check(
        (await readFile(configPath, 'utf8')) === original,
        'and left jotter.config.ts exactly as it found it',
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

      const generated = await readFile(join(overlayDir, 'site.json'), 'utf8')
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
        /**
         * And stops there. The trail used to end with the note's own title, one
         * line above the `<h1>` printing the same string, which on a snapshot
         * build — every note written at its slug — could say it three times over.
         */
        const crumb = criticalPage.match(/<p class="label note-crumb"[\s\S]*?<\/p>/)?.[0] ?? ''
        check(
          crumb !== '' && !crumb.includes('Critical Thinking'),
          'the breadcrumb stops at the folder, and does not repeat the heading beneath it',
          crumb === '' ? 'no crumb found' : crumb,
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
    /**
     * Before anything else rebuilds. A leftover overlay replaces
     * `jotter.config.ts`'s literal outright, so the RTL section below would
     * rewrite `dir` into a file nothing reads and then assert against a site
     * still in the fixture's Persian.
     */
    await rm(overlayDir, { recursive: true, force: true })
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
    : original.replace(CALL, `generated ?? {\n    dir: '${flipped}',`)

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

summary('All checks passed, including the full suite.')
