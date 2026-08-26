---
title: Kitchen sink
description: Every piece of syntax jotter renders, on one page.
tags: [meta, reference]
created: 2026-03-02
updated: 2026-08-26
---

Everything below is rendered by the real pipeline. If a thing works here, it
works in your vault.

## Links

A resolved link: [[Zettelkasten]]. One with an alias:
[[Atomic notes|small notes]]. One pointing at a heading:
[[Zettelkasten#How it works]].

A link to a note that was never written: [[A Note That Does Not Exist]]. It is
a muted, dotted span — not an anchor — so it cannot be clicked or focused.

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

## An unpublished target

This links to a note with `publish: false`: [[Half-formed]]. The alias the
author wrote is what shows — never the private note's own title.

## Images

An embed with a caption becomes a figure. The pipe rule is Obsidian's: a number
is a size, anything else is a caption.

![[slipbox.png|A gradient, standing in for a diagram]]

Sized to 320 wide, inline: ![[slipbox.png|320]]

An SVG is passed through untouched rather than re-encoded:

![[linked-cards.svg|Three cards, linked]]

## Whitespace probe

The spaces in the next line are load-bearing. Astro 7 changed `compressHTML`
to `'jsx'`, which strips whitespace between inline elements the way React
does; on a typography theme that would eat the gaps below. The build asserts
this exact line survives.

Probe: word *emphasis* [[Zettelkasten]] `code` **strong** end.
