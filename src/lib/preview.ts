/**
 * What a hover preview shows for one link, decided once at build time.
 *
 * The whole build-time half of the feature is this function, kept in `src/lib/`
 * where vitest can reach it without a document, a DOM or a running Astro.
 *
 * jotter's previews are **embedded, not fetched**. Quartz's `popover.inline.ts`
 * calls `fetchCanonical(targetUrl)` on every hover, parses the response with
 * `DOMParser` and lifts out its `.popover-hint` elements; Obsidian Publish does
 * the same against its own API. jotter cannot, and says so out loud —
 * `scripts/verify-build.mjs` fails the build on `fetch(` anywhere in an inline
 * block or a bundled chunk. So the excerpt travels in the HTML instead and the
 * browser never asks for anything.
 *
 * That deletes a layer rather than trading one for another: nothing is awaited,
 * so there is no race to guard; nothing is injected as HTML, so there are no
 * duplicate ids to rewrite; and nothing is fetched twice, so there is no cache.
 *
 * The cost is honest and worth stating: **the first paragraph, not the whole
 * note.** That is exactly what `excerpt()` was written for.
 */
import { excerpt } from './excerpt.js'
import { slugifyHeading } from './slug.js'
import { sectionById } from './transclude.js'
import type { VaultNote } from './vault.js'

export interface Preview {
  /** The note's title, plus ` > Heading` when the link points into a section. */
  title: string
  /** The opening paragraph of whatever the link points at. */
  text: string
}

/**
 * `sectionById` re-runs `protectedRanges()` over the whole body per call, which
 * is superlinear in note size, and one hub page can link into the same note a
 * dozen times.
 *
 * Keyed on the note *object* rather than on `path + subpath`, so a re-scanned
 * vault gets fresh answers by construction instead of by anyone remembering to
 * clear a cache — and so the entries go when the vault does.
 */
const memo = new WeakMap<VaultNote, Map<string, Preview | undefined>>()

/**
 * @param subpath the link's `#fragment`, as written *or* already slugified.
 *                Both forms arrive here: a wikilink carries `#How it works`, a
 *                link that transclusion pre-resolved carries `#how-it-works`.
 */
export function previewFor(note: VaultNote, subpath: string): Preview | undefined {
  let bySubpath = memo.get(note)
  if (!bySubpath) memo.set(note, (bySubpath = new Map()))
  if (bySubpath.has(subpath)) return bySubpath.get(subpath)

  const preview = compute(note, subpath)
  bySubpath.set(subpath, preview)
  return preview
}

function compute(note: VaultNote, subpath: string): Preview | undefined {
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
    if (section && text) return { title: `${note.title} > ${section.heading}`, text }
  }

  /**
   * Fall back, then give up. A heading that does not exist, one inside a code
   * fence and Obsidian's multi-level `#H1#H2` all land here, and the note's own
   * opening is a better answer than a card with a blank body. When even that is
   * empty the anchor gets *no attributes* rather than an empty card.
   */
  return note.excerpt ? { title: note.title, text: note.excerpt } : undefined
}
