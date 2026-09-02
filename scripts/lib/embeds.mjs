/**
 * The one step of the pipeline that fetches from somebody other than the
 * storage bucket, and the reason it is worth doing here rather than in the
 * browser.
 *
 * jotter refuses to put a third party on a reader's page. That refusal is
 * written down (`README.md`, and the origin assertion in
 * `scripts/verify-build.mjs` enforces it), and it is why a pasted YouTube URL
 * has always rendered as a link where Obsidian renders a player. A *facade*
 * keeps the refusal and gives the reader the player anyway: a poster, a play
 * control, and no request to anybody until the reader clicks.
 *
 * A facade needs a poster, and `lite-youtube-embed`, the standard answer to
 * this problem, gets one from `i.ytimg.com` at runtime: exactly the request
 * jotter forbids. So the poster is downloaded *here*, at build time, into the
 * vault's own attachments, and served from the site like any other image.
 *
 * ## Nothing in this file may fail a build
 *
 * Every failure degrades. A thumbnail that 404s, an oEmbed endpoint that rate
 * limits, a deleted tweet, a CI runner with no egress: each of those produces
 * one less entry in `.jotter/embeds.json`, and `src/markdown/wikilinks.ts`
 * renders a poster-less facade or a link card. A site does not stop deploying
 * because YouTube was slow.
 *
 * ## And nothing in it may invent content
 *
 * A tweet that cannot be fetched becomes a link to the tweet. It never becomes
 * a card with plausible text in it.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * The recogniser, imported rather than copied.
 *
 * `src/lib/embed.ts` is TypeScript and this is a plain Node script, which is
 * the reason `lib/site-config.mjs` keeps its own copy of one list. The two
 * cases are not alike: that one is seven string literals with a test asserting
 * the copies match, and this is URL parsing across four host families, where a
 * copy that drifts means posters fetched for videos that render as cards.
 * Node strips the types on import (stable since 23.6, and this package requires
 * 24.20), and `embed.ts` imports nothing at all, so there is nothing else to
 * resolve.
 */
import { embedKey, remoteEmbed } from '../../src/lib/embed.ts'

/** Where posters are written, relative to the vault root. */
export const POSTER_DIR = 'attachments/embeds'

/** Long enough for a slow CDN, short enough that a hung host is not the build. */
const TIMEOUT_MS = 8000

/** No build should spend minutes on decoration. */
const CONCURRENCY = 6

/**
 * YouTube's thumbnail ladder, best first.
 *
 * `maxresdefault` is the 720p frame and it **frequently does not exist**: it is
 * only generated for videos uploaded at that resolution or above, and 404s
 * otherwise. `hqdefault` is generated for every video there has ever been, so
 * it is the floor rather than another guess. The sizes are fixed by YouTube and
 * are what let the facade reserve its space without measuring the file.
 */
const YOUTUBE_POSTERS = [
  { file: 'maxresdefault.jpg', width: 1280, height: 720 },
  { file: 'hqdefault.jpg', width: 480, height: 360 },
]

/**
 * Markdown image syntax: `![alt](url)`, which is how a remote embed is written.
 * Wikilink embeds are not scanned because `![[…]]` names something in the
 * vault; Obsidian does not accept a URL there.
 *
 * A URL inside a code fence is matched too, and that is deliberate: skipping it
 * would mean carrying `protectedRanges` into this script for the sake of one
 * unused entry in a JSON file, which is a worse trade than one wasted request.
 */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g

/**
 * Every remote thing this markdown embeds, deduplicated by what it *is* rather
 * than by how it was spelled: two notes citing one video through different
 * tracking parameters are one poster to fetch.
 *
 * @param sources markdown bodies
 * @returns {Map<string, {kind: string, id: string, playlist?: boolean, url: string}>}
 */
export function findRemoteEmbeds(sources) {
  const found = new Map()
  for (const source of sources) {
    for (const [, url] of String(source ?? '').matchAll(MARKDOWN_IMAGE)) {
      const embed = remoteEmbed(url)
      if (!embed) continue
      const key = embedKey(embed)
      if (!found.has(key)) found.set(key, { ...embed, url })
    }
  }
  return found
}

/** `fetch` with a deadline, and never a throw: `undefined` is the failure. */
async function get(url, { as = 'json' } = {}) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: as === 'json' ? 'application/json' : 'image/*' },
    })
    if (!response.ok) return undefined
    return as === 'json' ? await response.json() : Buffer.from(await response.arrayBuffer())
  } catch {
    return undefined
  }
}

/** Bounded concurrency, the same shape as `pool` in `lib/snapshot.mjs`. */
async function pool(items, limit, worker) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++
        if (index >= items.length) return
        await worker(items[index])
      }
    }),
  )
}

/**
 * A poster for a YouTube video: `maxresdefault`, then `hqdefault`, then none.
 *
 * A playlist has no thumbnail of its own that is not one of its videos', so it
 * gets a poster-less facade rather than a frame from a video the author did not
 * link to.
 */
async function youtubePoster(embed) {
  if (embed.playlist) return undefined
  for (const { file, width, height } of YOUTUBE_POSTERS) {
    const body = await get(`https://i.ytimg.com/vi/${encodeURIComponent(embed.id)}/${file}`, {
      as: 'bytes',
    })
    // YouTube answers a missing `maxresdefault` with a 404, which `get` has
    // already turned into `undefined`; the length test catches a host that
    // answers 200 with a placeholder instead.
    if (body && body.length > 1024) return { body, width, height, ext: 'jpg' }
  }
  return undefined
}

/** Vimeo publishes no predictable thumbnail URL, so oEmbed is asked for one. */
async function vimeoPoster(embed) {
  const meta = await get(
    `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${embed.id}`)}`,
  )
  const src = typeof meta?.thumbnail_url === 'string' ? meta.thumbnail_url : undefined
  if (!src) return undefined

  const body = await get(src, { as: 'bytes' })
  if (!body || body.length <= 1024) return undefined

  const width = Number(meta.thumbnail_width)
  const height = Number(meta.thumbnail_height)
  return {
    body,
    ...(Number.isFinite(width) && width > 0 ? { width } : {}),
    ...(Number.isFinite(height) && height > 0 ? { height } : {}),
    ext: /\.png(?:\?|$)/i.test(src) ? 'png' : 'jpg',
  }
}

/** Tags out, entities in, whitespace collapsed. */
export function textOf(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip);/gi, (_, name) => {
      const named = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
        nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
      }
      return named[name.toLowerCase()] ?? ''
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * A tweet as strings, from X's oEmbed endpoint.
 *
 * `publish.x.com/oembed` needs no authentication. `omit_script=1` is what makes
 * the response usable here: without it the HTML carries a `<script src>` for
 * `platform.twitter.com`, which is the thing this whole design exists to keep
 * off the page. `dnt=1` asks X not to track the request.
 *
 * The `<blockquote>` it returns is parsed into text and attribution rather than
 * kept as markup, so `src/markdown/wikilinks.ts` renders jotter's own elements:
 * nothing to sanitise, and no borrowed stylesheet to fight. `author_name` and
 * `author_url` come from the JSON, which is more reliable than reading them
 * back out of the HTML.
 */
export async function fetchTweet(url) {
  const meta = await get(
    `https://publish.x.com/oembed?omit_script=1&dnt=1&url=${encodeURIComponent(url)}`,
  )
  const html = typeof meta?.html === 'string' ? meta.html : undefined
  if (!html) return undefined

  const body = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/i.exec(html)?.[1] ?? html
  // The quote is `<p>…the tweet…</p>` followed by the byline and a dated
  // permalink. Taking the paragraph is what separates one from the other.
  const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(body)?.[1]
  const text = textOf(paragraph ?? body)
  if (!text) return undefined

  const author = typeof meta.author_name === 'string' ? meta.author_name : undefined
  const handle = typeof meta.author_url === 'string' ? meta.author_url.split('/').pop() : undefined
  // The permalink's own label is the date, in X's format for the tweet's locale.
  const date = textOf(/<a[^>]*>([^<]*)<\/a>\s*<\/blockquote>/i.exec(html)?.[1] ?? '')

  return {
    text,
    ...(author ? { author } : {}),
    ...(handle ? { handle: `@${handle}` } : {}),
    ...(date ? { date } : {}),
  }
}

/**
 * Fetch what every remote embed in these notes needs, write the posters into
 * the vault, and return the index `src/lib/embeds-index.ts` reads.
 *
 * @param sources markdown bodies to scan
 * @param vault   absolute path of the vault directory
 * @param report  called with one human sentence per thing worth saying
 * @returns {Promise<Record<string, object>>} keyed by `embedKey`
 */
export async function collectEmbeds(sources, vault, report = () => {}) {
  const wanted = [...findRemoteEmbeds(sources).entries()]
  if (wanted.length === 0) return {}

  const index = {}
  let posters = 0
  let tweets = 0
  const missed = []

  await pool(wanted, CONCURRENCY, async ([key, embed]) => {
    if (embed.kind === 'tweet') {
      const tweet = await fetchTweet(embed.url)
      if (!tweet) {
        missed.push(embed.url)
        return
      }
      index[key] = tweet
      tweets++
      return
    }

    const poster =
      embed.kind === 'youtube' ? await youtubePoster(embed) : await vimeoPoster(embed)
    if (!poster) {
      missed.push(embed.url)
      return
    }

    const relative = `${POSTER_DIR}/${embed.kind}-${embed.id}.${poster.ext}`
    const target = join(vault, ...relative.split('/'))
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, poster.body)
    } catch (error) {
      // An unwritable attachments directory is a real problem, but it is not
      // this decoration's to report as fatal: the note itself was written.
      missed.push(`${embed.url} (${error.message})`)
      return
    }

    index[key] = {
      poster: relative,
      ...(poster.width ? { width: poster.width } : {}),
      ...(poster.height ? { height: poster.height } : {}),
    }
    posters++
  })

  const found = posters + tweets
  if (found > 0) {
    report(
      `${found} remote embed(s) prepared for click-to-play: ${posters} poster(s), ` +
        `${tweets} tweet(s). No third-party request reaches the built page.`,
    )
  }
  if (missed.length > 0) {
    report(
      `${missed.length} remote embed(s) could not be fetched and stay link cards: ` +
        `${missed.slice(0, 5).join(', ')}${missed.length > 5 ? ', …' : ''}`,
    )
  }
  return index
}
