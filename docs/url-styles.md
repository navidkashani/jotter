# URLs jotter is told, not URLs jotter invents

By default a path becomes a slug: `Wisdom & Approaches/Critical Thinking.md` is
served at `/wisdom-approaches/critical-thinking`. That is right for a new site
and wrong for one moving onto a domain whose old addresses are already in other
people's bookmarks and in Google's index.

Two opt-in keys change it: a **site-wide rule** for turning a path into an
address, and a **per-note override**. Both leave a default build byte-for-byte
unchanged.

## The site-wide rule: `slugs:`

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
  non-ASCII letters kept. It stays the default forever, because changing it
  would move every page on every jotter site built so far.
- **`preserve`** carries the vault path through untouched.
- **`obsidian`** does the same with one substitution, space to `+`, which is
  what Obsidian's form-urlencoding leaves once a URL is percent-decoded.

Two rules survive every style, because they are about routing rather than
naming: `.md` is dropped, and a trailing `index` claims its folder
(`Notes/index.md` gives `/Notes`, and a root `index.md` gives `/`).

## The per-note override: `permalink:`

```yaml
---
permalink: Company/About+us
---
```

The note is served **there**, and its derived slug 302s to it.

```
Company/About us.md   +   permalink: Company/About+us

  served at   /Company/About+us     ← canonical, sitemap, search, every link
  302 from    /company/about-us
```

**A 302 rather than a 301, on purpose.** That rule is recomputed from your
frontmatter on every build, so editing the `permalink:` away withdraws it. A 301
is a promise a browser keeps after the build stops making it: it caches one
indefinitely, and a browser holding the withdrawn half of a pair bounces between
the two until it gives up with `ERR_TOO_MANY_REDIRECTS`. Only an address jotter
cannot take back is permanent: `oldUrls:` below, and the `redirects` you write
into the config by hand.

It is honoured character for character in every mode: no lowercasing, no dashes,
no substitutions. Leading and trailing slashes are stripped.

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

If a `permalink:` claims a slug another note derived, the permalink wins, and
the displaced note keeps a page under a suffixed slug with a build warning
naming both files. Nothing is dropped.

## Slug and URL are not the same string

Conflating the two breaks both halves at once.

| | form | where it is used |
| --- | --- | --- |
| **slug** | `Wisdom+&+Approaches/Critical+Thinking` | the path in `dist/`, the route param, every `Map` key, and what `permalink:` is written as |
| **URL** | `/Wisdom+%26+Approaches/Critical+Thinking` | `<a href>`, canonical, `og:url`, sitemap, feed, search results, and the *source* of every redirect |

`+` is a literal plus in a URL **path**, never a space: only a query string
reads it that way. So the stored form carries a literal `+`, and only characters
like `&` need encoding. `src/lib/url.ts` holds the two functions that convert,
and nothing else in the build encodes a URL by hand.

jotter has four things that emit a page's URL: `<a href>`, the canonical and
`og:url`, the sitemap, and search results. All four go through that one encoder,
and `npm run verify:full` asserts they are byte-identical per page over a build
whose slugs carry a reserved character. They have to be: Google's URL guidelines
say links, the canonical link and the sitemap must use the identical spelling or
the page splits into duplicates.

## Two caveats worth knowing before you deploy

**Netlify lowercases.** It 301s a mixed-case path to its lowercase form, with no
opt-out, so `/Company/About+us` lands on `/company/about+us`, which the build
does not serve. Cloudflare Pages, Vercel and GitHub Pages all serve static
assets case-sensitively, as written. The build warns, by name, whenever it emits
a slug carrying an uppercase letter.

**`C++ Notes.md` cannot be spelled the way Obsidian spelled it.** Obsidian
form-urlencoded it to `C%2B%2B+Notes`, which percent-decodes to `C+++Notes`, and
that is the slug `obsidian` assigns, so the old address still resolves. What is
lost is the spelling: form-urlencoding cannot be recovered from a
percent-decoded string, because `+` there is ambiguous between a space and a
plus. The page is reachable either way.

Two more things the build reports without changing:

- **Slugs differing only in case.** Two pages on Linux, one file on macOS and
  Windows, so one silently overwrites the other depending on where the site is
  built.
- **Windows-illegal characters** (`< > : " | ? * \`). Legal on macOS and Linux,
  un-writable into `dist/` on a Windows build machine.

A slug that would escape `dist/` (a leading `/`, or a `.` or `..` segment) stops
the build instead, naming the note.

## Open Publish, and the two answers to an old URL

The Open Publish **Quartz** starter records each note's old Obsidian URL in
frontmatter as `permalink:`, percent-decoded, because Quartz runs every
`aliases` entry through `slugifyFilePath` and `permalink` is the one key it
honours character for character.

jotter reads the same key, so a vault that starter prepared needs no change, and
it gives a better result than Quartz does: there, `permalink` emits a `noindex`
meta-refresh bounce page and the note stays at its derived slug. Here the old
Obsidian URL becomes the real, canonical URL. See
[migrating-from-quartz.md](migrating-from-quartz.md).

**jotter's own snapshot layer chooses the other answer.**
`scripts/fetch-content.mjs` writes old addresses to `oldUrls:` rather than
`permalink:`, because jotter honours both character for character and can
therefore pick the one that leaves the note where the plugin put it.

| the old URL written as | `/Wisdom+%26+Approaches/Critical+Thinking` becomes | the note is served at |
| --- | --- | --- |
| `permalink:` | the note's own address | the old URL, and its slug 302s to it |
| `oldUrls:` | a **301** to the note | the slug the plugin published |

`oldUrls:` is the one generated rule that is permanent. Everything else on this
page is recomputed from what your frontmatter says today, so the next build can
withdraw it, and an address publish.obsidian.md served cannot be withdrawn by
anybody. It is also the row carrying a migrated site's entire search history.

Renames arrive as `renamedFrom:`. Same shape, same redirect, one difference:
rename the note back and the rule reverses, so it is a 302 while `oldUrls:` is a
301. Both are keys of their own rather than more `aliases:`, because the header
block prints `aliases` under "Also known as", and `About/How+to+Communicate` is
not a name anybody gave a note. See [open-publish.md](open-publish.md).

## `astro dev` and the host agree

Astro's dev router decodes an incoming pathname with `decodeURI`, which does not
decode `%26`, and then keys static paths by the raw param. So a link to
`/Wisdom+%26+Approaches/…` would 404 in dev while working perfectly in
production, where the host percent-decodes before the file lookup. jotter's
vault integration rewrites the request to the one form that router is stable
under. It does nothing to a URL without an encoded reserved character, so a
`derive` site sees no change.

## Sources

- [RFC 3986 §3.3, §6.2.2.2](https://datatracker.ietf.org/doc/rfc3986/): `pchar`, sub-delims, and reserved characters protected from normalisation
- [Google URL structure guidelines](https://developers.google.com/search/docs/crawling-indexing/url-structure)
- [Obsidian Publish permalinks](https://forum.obsidian.md/t/ability-to-specify-permalinks-in-frontmatter/8989)
- [Eleventy permalinks](https://www.11ty.dev/docs/permalinks/), [Hugo URL management](https://gohugo.io/content-management/urls/)
- [Netlify redirects](https://docs.netlify.com/manage/routing/redirects/overview/): paths in `_redirects` must be URL-encoded
- [Enforcing case sensitivity on Netlify](https://answers.netlify.com/t/enforcing-case-sensitivity-for-url-paths-on-netlify/123969)
- [Cloudflare Pages: serving pages](https://developers.cloudflare.com/pages/configuration/serving-pages/)
- [sitemaps.org protocol](https://www.sitemaps.org/protocol.html): percent-encoding *and* XML entity escaping
