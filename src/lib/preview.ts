/**
 * What a hover preview shows for one link, decided once at build time.
 *
 * The whole build-time half of the feature is this function, kept in `src/lib/`
 * where vitest can reach it without a document, a DOM or a running Astro.
 *
 * jotter's previews are **embedded, not fetched**. Quartz's `popover.inline.ts`
 * calls `fetchCanonical(targetUrl)` on every hover, parses the response with
 * `DOMParser` and lifts out its `.popover-hint` elements; Obsidian Publish does
 * the same against its own API. jotter does not, and says so out loud:
 * `scripts/verify-build.mjs` fails the build on `fetch(` anywhere in an inline
 * block or a bundled chunk. So the excerpt travels in the HTML instead and the
 * browser never asks for anything.
 *
 * That assertion has exactly one exemption, added when search shipped:
 * `dist/pagefind/**`, by path. Pagefind fetches because fetching *is* how it
 * scales, and there was no embed-it-at-build-time way out the way there was
 * here. Everything jotter authors (this feature included) still fails on
 * `fetch(`, which is what keeps the decision below enforced rather than merely
 * remembered.
 *
 * That deletes a layer rather than trading one for another: nothing is awaited,
 * so there is no race to guard; nothing is injected as HTML, so there are no
 * duplicate ids to rewrite; and nothing is fetched twice, so there is no cache.
 *
 * The cost is honest and worth stating: **the first paragraph, not the whole
 * note.** That is exactly what `excerpt()` was written for.
 */
import { firstStrong, textDir, type Direction } from './bidi.js'
import { excerpt } from './excerpt.js'
import { slugifyHeading } from './slug.js'
import { sectionById } from './transclude.js'
import type { VaultNote } from './vault.js'

export interface Preview {
  /** The note's title, plus ` > Heading` when the link points into a section. */
  title: string
  /** The opening paragraph of whatever the link points at. */
  text: string
  /**
   * The direction each half needs, or `undefined` when it needs none.
   *
   * The card is built in the browser and appended to `document.body`, so it
   * inherits `<html dir>` and nothing else: the direction of the *note being
   * previewed* is not something the DOM can tell it. But the text is known
   * here, at build time, which is why these are an explicit answer and not a
   * `dir="auto"` on the card. Same rule as every block in the prose: say it
   * only when it differs from the page, so a monolingual vault emits neither.
   */
  titleDir?: Direction
  textDir?: Direction
}

/**
 * First-strong isolate and its terminator, for the section-title separator.
 *
 * ` > ` sits between two runs that may disagree, and it is bidi-**neutral**:
 * between a Persian note title and an English heading the UBA reorders it and
 * the card reads `How it works < عنوان`. Isolating each half pins them.
 */
const FSI = '\u2068'
const PDI = '\u2069'

/**
 * `sectionById` re-runs `protectedRanges()` over the whole body per call, which
 * is superlinear in note size, and one hub page can link into the same note a
 * dozen times.
 *
 * Keyed on the note *object* rather than on `path + subpath`, so a re-scanned
 * vault gets fresh answers by construction instead of by anyone remembering to
 * clear a cache, and so the entries go when the vault does.
 *
 * The key carries the base direction as well, because the answer now depends on
 * it: a process that renders the same vault both ways round (which is exactly
 * what `scripts/verify-theme.mjs` does) would otherwise be served the first
 * direction's answer for the second. `base` is one of two literals with no
 * space in either, so a space is an unambiguous separator from the subpath.
 */
const memo = new WeakMap<VaultNote, Map<string, Preview | undefined>>()

/**
 * @param subpath the link's `#fragment`, as written *or* already slugified.
 *                Both forms arrive here: a wikilink carries `#How it works`, a
 *                link that transclusion pre-resolved carries `#how-it-works`.
 * @param base    the direction the page inherits, against which each half of
 *                the card is asked whether it has anything to say.
 */
export function previewFor(note: VaultNote, subpath: string, base: Direction): Preview | undefined {
  let byKey = memo.get(note)
  if (!byKey) memo.set(note, (byKey = new Map()))
  const key = `${base} ${subpath}`
  if (byKey.has(key)) return byKey.get(key)

  const preview = compute(note, subpath, base)
  byKey.set(key, preview)
  return preview
}

function compute(note: VaultNote, subpath: string, base: Direction): Preview | undefined {
  /**
   * `#^blockref` falls straight through to the note's opening, because
   * `sectionOf` has resolved a block reference to the whole note since v1 and
   * a preview that disagreed with the transclusion of the same target would be
   * the surprise. There is a test saying so.
   */
  if (subpath && !subpath.startsWith('#^')) {
    const section = sectionById(note.body, slugifyHeading(subpath.slice(1)))
    const text = section && excerpt(section.body)
    // ` > ` rather than a typographic `›`, matching the separator `liveLabel`
    // already puts in the link's own text. The card sits beside the link it
    // came from; two spellings of one separator would read as two things.
    if (section && text) {
      const raw = `${note.title} > ${section.heading}`
      /**
       * Wrapped **only when the two halves disagree**. Wrapping unconditionally
       * would put two control characters into every previewed section anchor of
       * a monolingual vault, which is the zero-cost claim broken for no gain:
       * a neutral between two runs that agree cannot reorder.
       *
       * `titleDir` is read off `raw`, before the wrapping. `firstStrong`
       * deliberately skips an isolated run (UBA P2, pinned in
       * `test/bidi.test.ts`), so the wrapped string answers `undefined` and the
       * card would lose the direction it just went to the trouble of keeping.
       */
      const halves = [firstStrong(note.title), firstStrong(section.heading)]
      const title =
        halves[0] && halves[1] && halves[0] !== halves[1]
          ? `${FSI}${note.title}${PDI} > ${FSI}${section.heading}${PDI}`
          : raw
      return { title, text, ...dirs(raw, text, base) }
    }
  }

  /**
   * Fall back, then give up. A heading that does not exist, one inside a code
   * fence and Obsidian's multi-level `#H1#H2` all land here, and the note's own
   * opening is a better answer than a card with a blank body. When even that is
   * empty the anchor gets *no attributes* rather than an empty card.
   */
  return note.excerpt
    ? { title: note.title, text: note.excerpt, ...dirs(note.title, note.excerpt, base) }
    : undefined
}

/**
 * The two optional halves, spread rather than assigned, so a preview that has
 * nothing to say carries no keys at all. `JSON`-shaped equality in the tests
 * then reads the same as the emitted markup does.
 */
function dirs(title: string, text: string, base: Direction) {
  const forTitle = textDir(title, base)
  const forText = textDir(text, base)
  return {
    ...(forTitle ? { titleDir: forTitle } : {}),
    ...(forText ? { textDir: forText } : {}),
  }
}
