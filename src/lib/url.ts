/**
 * The two functions that turn a slug into a URL and back, and nothing else.
 *
 * ## Why this is its own module, importing nothing
 *
 * `src/lib/search.ts` is bundled into the browser and its docstring forbids it
 * from importing anything node-shaped: the moment it does, the search script
 * stops building. It needs the encoder, because a Pagefind result has to be
 * spelled the way every `<a href>` on the site is. So the encoder lives here,
 * with **no imports at all**, and both the build-time half of jotter and the
 * bundled half can reach it.
 *
 * ## Slug and URL are not the same string
 *
 * | | form | where it is used |
 * | --- | --- | --- |
 * | **slug** | `Wisdom+&+Approaches/Critical+Thinking` | the path in `dist/`, the `[...slug]` param, every `Map` key (`bySlug`, graph, backlinks, `taken`), and what `permalink:` is written as |
 * | **URL** | `/Wisdom+%26+Approaches/Critical+Thinking` | `<a href>`, canonical, `og:url`, sitemap, feed, search results, and the *source* of every `_redirects` / `vercel.json` entry |
 *
 * `+` is a literal plus in a URL *path*, never a space: only a query string
 * reads it that way (RFC 3986 §3.3 lists it as a sub-delim, legal in a segment).
 * So the stored form carries a literal `+` and only characters like `&` need
 * encoding. That is why Open Publish stores its `legacyUrls` percent-*decoded*,
 * and it is the same split.
 *
 * Conflating the two breaks both directions at once: a slug used as a URL emits
 * `/a&b`, which RFC 3986 §6.2.2.2 says is a *different* URL from `/a%26b`, so
 * links and canonical disagree and Google splits the page into duplicates; a
 * URL used as a slug misses every `Map` in the build.
 *
 * ## The one place byte-parity with Obsidian Publish is impossible
 *
 * `C++ Notes.md`. Obsidian form-urlencoded each segment, so it served
 * `C%2B%2B+Notes`, which percent-decodes to the slug `C+++Notes`, and that is
 * the slug `obsidian` assigns, so the old address still *resolves*: a static
 * host decodes the request path before looking for the file. What cannot be
 * reproduced is the **spelling**. jotter emits `C+++Notes`, because
 * form-urlencoding cannot be recovered from a percent-decoded string: `+` there
 * is ambiguous between "a space" and "a plus", and a slug is on the far side of
 * that ambiguity. The invariant holds and the page is reachable; only the bytes
 * on the wire differ.
 */

/**
 * slug → URL path. Encoding only: it never lowercases and never substitutes.
 *
 * Per segment, so `/` stays a separator rather than becoming `%2F`. `+` is
 * restored after `encodeURIComponent` escapes it, because a literal plus is
 * legal in a path and re-encoding it would make every Obsidian-style URL
 * disagree with the address it is supposed to reproduce.
 */
export const encodeSlug = (slug: string): string =>
  slug
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%2B/g, '+'))
    .join('/')

/**
 * URL path → slug. The inverse of `encodeSlug`: `decodeURIComponent` leaves `+`
 * alone, which is exactly the behaviour a path needs.
 *
 * `encodeSlug` never emits a malformed escape, so `decodeSlug(encodeSlug(s))`
 * is always `s`. On input jotter did not write (a Pagefind URL read off a file
 * named `100% done`, a hand-typed link) a segment that is not valid
 * percent-encoding comes back unchanged rather than throwing. That guard used
 * to live at the one call site that had noticed the problem
 * (`src/markdown/wikilinks.ts`, "a malformed escape is not ours to repair");
 * it belongs with the function, so there is one mirror of `encodeSlug` rather
 * than several that can drift.
 */
export const decodeSlug = (path: string): string =>
  path
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join('/')
