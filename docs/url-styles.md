# URLs jotter is told, not URLs jotter invents

Somebody moving off Obsidian Publish who keeps their own domain loses every
inbound link and every search ranking they had, because a generator's slug
scheme differs from Obsidian's. `Company/About us.md` was served at
`/Company/About+us`, and a site that now serves it at `/company/about-us` has
broken every one of those links: silently, on the day of the move.

Two independent things fix that. A **site-wide rule** for turning a path into an
address, and a **per-note override**. Jekyll, Hugo, 11ty and Obsidian Publish
itself all have exactly that pair.

Both are opt-in, and the default is byte-for-byte what jotter has always done.
A vault pointed at a folder of markdown is unaffected: no manifest, no scripts,
no new required frontmatter.

---

## The site-wide rule: `slugs:`

One line in `jotter.config.ts`.

```ts
export default defineConfig({
  slugs: 'obsidian',   // 'derive' (default) | 'preserve' | 'obsidian'
})
```

For a vault holding `Wisdom & Approaches/Critical Thinking.md`:

| `slugs:` | URL served |
| --- | --- |
| `'derive'` *(default)* | `/wisdom-approaches/critical-thinking` |
| `'preserve'` | `/Wisdom%20&%20Approaches/Critical%20Thinking` |
| `'obsidian'` | `/Wisdom+%26+Approaches/Critical+Thinking` |

That last row is byte-identical to what Obsidian Publish serves.

- **`derive`** slugifies: lowercase, spaces to dashes, punctuation dropped,
  non-ASCII letters kept. This is what every jotter site built so far is
  published at, and it stays the default forever: changing it would move every
  page on all of them.
- **`preserve`** carries the vault path through untouched.
- **`obsidian`** does the same with one substitution, space to `+`, which is
  what Obsidian's form-urlencoding leaves once a URL is percent-decoded.

Two rules survive every style, because they are about routing rather than
naming: `.md` is dropped, and a trailing `index` claims its folder
(`Notes/index.md` → `/Notes`, a root `index.md` → `/`).

---

## The per-note override: `permalink:`

```yaml
---
permalink: Company/About+us
---
```

The note is served **there**, and its derived slug 301s to it.

```
Company/About us.md   +   permalink: Company/About+us

  served at   /Company/About+us     ← canonical, sitemap, search, every link
  301 from    /company/about-us
```

Honoured character for character in every mode: no lowercasing, no dashes, no
substitutions. Leading and trailing slashes are stripped, so `/company/about`
and `company/about` mean the same thing, which is what Hugo does with `url:`.

A note may name more than one:

```yaml
permalink: [Company/About+us, Company/About, about]
```

The first is where the note is served. The rest become redirects to it, in
`_redirects` and `vercel.json`.

Precedence, when several things want to move the same note:

```
config.homepage  >  homepage: true  >  permalink:  >  the vault path
```

If a `permalink:` claims a slug another note derived, the permalink wins (it is
the deliberate statement of the two), and the displaced note keeps a page under
a suffixed slug, with a build warning naming both files. Nothing is dropped.

---

## Slug and URL are not the same string

This is the distinction the whole feature rests on, and conflating the two
breaks both halves at once.

| | form | where it is used |
| --- | --- | --- |
| **slug** | `Wisdom+&+Approaches/Critical+Thinking` | the path in `dist/`, the route param, every `Map` key, and what `permalink:` is written as |
| **URL** | `/Wisdom+%26+Approaches/Critical+Thinking` | `<a href>`, canonical, `og:url`, sitemap, feed, search results, and the *source* of every redirect |

`+` is a literal plus in a URL **path**, never a space: only a query string
reads it that way. So the stored form carries a literal `+`, and only characters
like `&` need encoding. `src/lib/url.ts` holds the two functions that convert,
and nothing else in the build encodes a URL by hand.

---

## The four producers agree

RFC 3986 §6.2.2.2 protects percent-encoded reserved characters from
normalisation, so `/a%26b` and `/a&b` are formally *different* URLs. Google's URL
guidelines say reserved characters must be percent-encoded, and that links, the
canonical link and the sitemap have to use the identical spelling or the page
splits into duplicates.

jotter has four things that emit a page's URL, and all four go through the same
encoder:

| producer | how |
| --- | --- |
| `<a href>` | `noteHref()` in `src/lib/href.ts` |
| canonical and `og:url` | `src/layouts/Base.astro` re-encodes `Astro.url.pathname` |
| sitemap | the `serialize` option in `astro.config.ts` |
| search | `normalizeResultUrl()` re-encodes the raw file path Pagefind indexed |

`npm run verify:full` asserts they are byte-identical, per page, over a build
whose slugs carry a reserved character: not merely that each link resolves.

---

## Two caveats worth knowing before you deploy

**Netlify lowercases.** It 301s a mixed-case path to its lowercase form, with no
opt-out, so `/Company/About+us` lands on `/company/about+us`, which the build
does not serve. Cloudflare Pages, Vercel and GitHub Pages all serve static
assets case-sensitively, as written. The build warns, by name, whenever it emits
a slug carrying an uppercase letter.

**`C++ Notes.md` cannot be spelled the way Obsidian spelled it.** Obsidian
form-urlencoded it to `C%2B%2B+Notes`, which percent-decodes to `C+++Notes`,
and that is the slug `obsidian` assigns, so the old address still resolves: a
static host decodes the request path before looking for the file. What is lost
is the spelling. jotter emits `C+++Notes`, because form-urlencoding cannot be
recovered from a percent-decoded string: `+` there is ambiguous between a space
and a plus. The page is reachable either way; only the bytes on the wire differ.

Two more things the build reports without changing:

- **Slugs differing only in case.** Two pages on Linux, one file on macOS and
  Windows, so one silently overwrites the other depending on where the site is
  built.
- **Windows-illegal characters** (`< > : " | ? * \`). Legal on macOS and Linux,
  un-writable into `dist/` on a Windows build machine.

A slug that would escape `dist/` (a leading `/`, or a `.` or `..` segment)
stops the build instead, naming the note.

---

## Open Publish, and the two answers to an old URL

The Open Publish **Quartz** starter records each note's old Obsidian URL in
frontmatter as `permalink:`
(`starters/quartz/scripts/lib/frontmatter.mjs`), percent-decoded, because
Quartz runs every `aliases` entry through `slugifyFilePath` (which maps `&` to
`-and-` and `%` to `-percent`), and `permalink` is the one key it honours
character for character.

jotter reads the same key, so a vault that starter prepared needs no change, and
it gives a better result than Quartz does: there, `permalink` emits a `noindex`
meta-refresh bounce page and the note stays at its derived slug. Here the old
Obsidian URL becomes the real, canonical URL: no bounce page, no meta-refresh,
no `noindex`. Which is what "keep your existing URLs" was supposed to mean. See
[migrating-from-quartz.md](migrating-from-quartz.md).

**jotter's own snapshot layer chooses the other answer.**
`scripts/fetch-content.mjs`, which builds this repository straight from an Open
Publish bucket, writes old addresses to `aliases:` rather than `permalink:`,
because jotter honours both character for character and can therefore pick the
one that leaves the note where the plugin put it.

| the old URL written as | `/Wisdom+%26+Approaches/Critical+Thinking` becomes | the note is served at |
| --- | --- | --- |
| `permalink:` | the note's own address | the old URL, and its slug 301s to it |
| `aliases:` | a 301 to the note | the slug the plugin published |

The second row is what a site moving *onto* clean slugs wants: the old address
keeps answering, and every new link, canonical and sitemap entry spells the
address the plugin published. See [open-publish.md](open-publish.md).

---

## `astro dev` and the host agree

Astro's dev router decodes an incoming pathname with `decodeURI`, which does not
decode `%26`, and then keys static paths by the raw param, so a link to
`/Wisdom+%26+Approaches/…` would 404 in dev while working perfectly in
production, where the host percent-decodes before the file lookup. jotter's vault
integration rewrites the request to the one form that router is stable under. It
is a no-op for any URL without an encoded reserved character in it, so a
`derive` site sees no change.

---

## Sources

- [RFC 3986 §3.3, §6.2.2.2](https://datatracker.ietf.org/doc/rfc3986/): `pchar`, sub-delims, and reserved characters protected from normalisation
- [Google URL structure guidelines](https://developers.google.com/search/docs/crawling-indexing/url-structure)
- [Obsidian Publish permalinks](https://forum.obsidian.md/t/ability-to-specify-permalinks-in-frontmatter/8989): "a URL used instead of the auto-generated one"
- [Eleventy permalinks](https://www.11ty.dev/docs/permalinks/), [Hugo URL management](https://gohugo.io/content-management/urls/)
- [Netlify redirects](https://docs.netlify.com/manage/routing/redirects/overview/): paths in `_redirects` must be URL-encoded
- [Enforcing case sensitivity on Netlify](https://answers.netlify.com/t/enforcing-case-sensitivity-for-url-paths-on-netlify/123969)
- [Cloudflare Pages: serving pages](https://developers.cloudflare.com/pages/configuration/serving-pages/)
- [sitemaps.org protocol](https://www.sitemaps.org/protocol.html): percent-encoding *and* XML entity escaping
