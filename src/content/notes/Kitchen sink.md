---
title: Kitchen sink
description: Every piece of syntax jotter renders, on one page.
tags: [meta, reference]
image: attachments/slipbox.png
status: evergreen
source: The jotter README
author: The gardener
series: Reference
created: 2026-03-02
updated: 2026-08-26
---

Everything below is rendered by the real pipeline. If a thing works here, it
works in your vault.

## The header block

The boxed list above is this note's own frontmatter. `created` and `updated` are
always shown; `aliases`, `status`, `source`, `author` and `series` appear when
you set them. Every other key you keep up there stays off the page on purpose:
the list is an allow-list, so a private URL or a note-to-self in frontmatter is
never published by accident.

## Links

A resolved link: [[Zettelkasten]]. One with an alias:
[[Atomic notes|small notes]]. One pointing at a heading:
[[Zettelkasten#How it works]].

A link to a note that was never written: [[A Note That Does Not Exist]]. It is
a muted, dotted span (not an anchor), so it cannot be clicked or focused.

A link off the site: [Zettelkasten, on Wikipedia](https://en.wikipedia.org/wiki/Zettelkasten).
It carries an arrow, opens in a new tab, and says so to a screen reader in
words. It does **not** carry `nofollow`: an outbound link here is a citation,
and withholding credit from a source is not something a theme should decide on
its author's behalf.

An address is a scheme too, and gets none of that, because "opens in a new tab"
is a false promise about a mail client: <mailto:someone@example.com>.

## Emphasis and marks

Text can be *emphasised*, **strong**, ~~struck through~~, `inline code`, or
==highlighted==. Footnotes work too.[^1]

[^1]: Like this one.

## Callouts

> [!tip] Callouts take a title
> And a body, with **markdown** inside it.

> [!warning]- This one starts collapsed
> Add `-` to collapse a callout by default, or `+` to start it open.

> [!danger] Every Obsidian callout type is styled
> Each type is a hue in `tokens.css` and nothing else.

## Lists

- Sourdough starter
- Reading queue
  - [[Atomic notes]]
  - [[Zettelkasten]]

1. First
2. Second

- [x] Ship v1
- [ ] Write the graph

## A table

| Tool | Cost | Designed |
| --- | --- | --- |
| Quartz | free | functional |
| Obsidian Publish | ~$8/mo | functional |
| jotter | free | that is the point |

## Code

```ts
export function slugifySegment(segment: string): string {
  return segment.normalize('NFC').toLowerCase().replace(/[\s_]+/g, '-')
}
```

## Transclusion

Embedding a note inlines it, inside a block that always links back:

![[Atomic notes#The rule]]

## Tags

Inline tags become chips: #method/zettelkasten and #reference.

## Mixed direction

Every block above and below is read once, at build time, and the ones that run
the *other* way from the site are marked. This site is `dir: 'ltr'`, so the
English carries no attribute at all and only the Persian is marked `dir="rtl"`.
An Arabic or Hebrew site gets the mirror of this: its own script untouched, and
the English blocks marked instead. A vault written in one script pays nothing
either way.

اینجا محلی هست برای نوشتن یادداشت‌های کوتاه، به فارسی، در همان باغی که بقیه‌ی
یادداشت‌ها را نگه می‌دارد.

### صفحات من در فضای وب

- وبلاگ شخصی
- یک پیوند انگلیسی داخل یک جمله‌ی فارسی: [[Obsidian]]
- یک پیوند بیرونی: [ویکی‌پدیای فارسی](https://fa.wikipedia.org/): the arrow after
  a right-to-left link has to stay at the end of it, which is what
  `unicode-bidi: isolate` on `.external-link::after` is for.
- An English item, unmarked, in the same list.

The rule is Unicode's own (the first strong character wins), so a line that
opens with a year still resolves from the word after it, and a line of digits
or punctuation alone keeps whatever it inherits. The one case it gets wrong is
a Persian sentence opening with a Latin word, which Obsidian gets wrong too.
Put `direction: rtl` in that note's frontmatter to settle it.

## An unpublished target

This links to a note with `publish: false`: [[Half-formed]]. The alias the
author wrote is what shows: never the private note's own title.

## Images

An embed with a caption becomes a figure. The pipe rule is Obsidian's: a number
is a size, anything else is a caption.

![[slipbox.png|A gradient, standing in for a diagram]]

Sized to 320 wide, inline: ![[slipbox.png|320]]

An SVG is passed through untouched rather than re-encoded:

![[linked-cards.svg|Three cards, linked]]

## Remote embeds

A pasted video is a **facade**: a poster, a play control, and no request to
anybody until you click it. The player is fetched on that click, from
`youtube-nocookie.com`, so nothing is set in your browser by a page you were
only reading.

![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

The poster is downloaded into the vault at build time by the Open Publish
pipeline, which is the only step with a network. This site is not built that
way, so the facade above has no poster and says so by showing the panel
underneath: that is the degraded state, on purpose, rather than a broken image.

Anything else remote is a card naming where it goes, rather than the raw URL
with its tracking parameters read out as a label:

![](https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc123)

## Whitespace probe

The spaces in the next line are load-bearing. Astro 7 changed `compressHTML`
to `'jsx'`, which strips whitespace between inline elements the way React
does; on a typography theme that would eat the gaps below. The build asserts
this exact line survives.

Probe: word *emphasis* [[Zettelkasten]] `code` **strong** end.

## Escaping probe

Pagefind hands its excerpts back as *escaped* HTML with `<mark>` in them, so a
search result rebuilt by splitting that string would render the entities
literally. `src/scripts/search.ts` parses it instead. Nothing else in the demo
garden contains these characters, so this line is what proves it.

Probe: Ahrens & Luhmann's boxes hold 1 < 2 "quoted" cards.
