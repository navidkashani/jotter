---
title: jotter
aliases: [the theme]
tags: [meta, tool]
created: 2026-02-11
updated: 2026-08-24
---

An Astro theme for publishing an Obsidian vault, designed rather than merely
generated. The entire visual system is about forty custom properties in one
file, so changing the accent changes the site.

## What it does differently

> [!note] Links resolve the way Obsidian resolves them
> Obsidian's default is *shortest path*. Quartz's `CrawlLinks` defaults to
> `absolute`. A link that works in the app can 404 on a site built the other
> way. jotter defaults to `shortest`.

Wikilinks are parsed by the markdown engine, not by a regular expression over
your prose. That is why `[[this]]` inside a code fence stays literal, with no
special handling:

```markdown
Write [[Zettelkasten]] to link a note.
```

## What it does not do

Dataview, `.canvas`, Excalidraw, Mermaid and stacked notes are out of scope.
They are listed here rather than left to be discovered: a missing feature you
were warned about is a decision; one you find at 2am is a bug.

See also [[Kitchen sink]] for everything it renders.
