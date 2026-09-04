# Frontmatter

Everything is optional. A vault of bare markdown with no frontmatter builds on
the first try.

```yaml
---
title: Overridden title        # else the first H1, else the filename
description: For meta tags     # else the first paragraph
aliases: [Other Name]          # resolve links, and generate redirects
tags: [method/zettelkasten]    # merged with inline #tags
created: 2026-01-02            # else git, else file mtime
updated: 2026-03-04
status: evergreen              # these four show in the note's header block
source: Ahrens 2017
author: A. Writer
series: Reading notes
image: attachments/og.png      # the link-preview card, see docs/configuration.md
publish: false                 # exclude this note
draft: true                    # also excludes it
homepage: true                 # this note claims '/', see docs/configuration.md
permalink: Company/About+us    # serve this note here, see docs/url-styles.md
direction: rtl                 # this note's baseline, see below
---
```

Unknown keys are left alone. Your Dataview fields will not break the build.

## What the header block shows

The boxed list at the top of a note is `created`, `updated` when it differs, and
whichever of `aliases`, `status`, `source`, `author` and `series` you set. The
whole block is behind `features.metadata`, which is off by default.

A date row appears only where jotter has a real date to show: your frontmatter,
or the note's git history. The fallback to the file's mtime still happens, so
"recently updated" has something to sort by, but it is never printed under the
heading "Created". On a vault a generator wrote, that date is the moment of the
build.

That list is a fixed list of what jotter shows, not a list of what it hides.
Frontmatter is whatever its owner typed: a private URL, a note to self, a
`publish: false` you forgot to remove. So anything unrecognised stays off the
page. `oldUrls` and `renamedFrom`, which the Open Publish pipeline writes, are
deliberately not on the list: those are addresses rather than names, and
printing them under "Also known as" put `About/How+to+Communicate` on every page
of a migrated site.

`author` is display only. The name on the feed is `author` in
`jotter.config.ts`, which is a claim about who publishes the site rather than
who wrote one note.

## Spellings, and the three keys that are strict

Dates are read under five names each, so a vault written for another tool
usually needs no edits:

| jotter reads | from any of |
| --- | --- |
| created | `created`, `date`, `created_at`, `createdAt`, `published` |
| updated | `updated`, `modified`, `updated_at`, `updatedAt`, `lastmod` |

Values are taken leniently. `title: 2026` on a yearly review note is a title,
`tags: [2026, reading]` are tags, `aliases: [2026]` is an alias, and a date
jotter cannot parse falls back to git and then to the file's mtime. Nothing
there stops a build.

**`publish`, `draft` and `homepage` are the exception.** Those must be real
booleans, unquoted `true` or `false`, and anything else fails the build naming
the key. A quoted `publish: "false"` coerced generously is a note you meant to
hide, published, in silence. A misrouted `/` is the same mistake one key over.

## What the publish gate does

By default every note is published unless it says otherwise. Set
`publishGate: 'opt-in'` if you are pointing jotter at a real vault and want
`publish: true` to be required.

An excluded note gets no page, no route, and no mention. Links to it render as
inert `<span class="dead-link">`, labelled with the filename the author typed
and **never with the note's own title**. The build asserts this over every text
file in `dist/`, not only the pages, because the feed and the sitemap carry
titles too.

## Mixed-direction vaults

`dir` is the site's baseline, not its only direction. Every block is read at
build time, and the ones running the other way are marked:

```html
<!-- an English site (dir: 'ltr') -->
<h2>I'm Navid</h2>
<p>I'm a guy who enjoys…</p>
<p dir="rtl">اینجا محلی هست…</p>
<h3 dir="rtl">صفحات من در فضای وب</h3>
<li dir="rtl"><a>وبلاگ شخصی</a></li>
```

It is symmetric. An Arabic or Hebrew site (`dir: 'rtl'`) gets the mirror: its
own script untouched, and the English blocks marked `dir="ltr"` instead. The
majority language is never marked, so a vault written in one script emits not a
single extra byte.

The rule is the same one browsers use for `dir="auto"`, and the one Obsidian's
editor runs: the first strong character in a block wins. Digits, punctuation,
symbols and emoji do not vote, so `۱۳۹۹ سال خوبی بود` and `2026 مرور سال` both
resolve right-to-left. A block with no letters in it keeps whatever it inherits.

The one case it gets wrong is a sentence opening with a word from the other
script (`Obsidian یک برنامه است`), which Obsidian gets wrong too. Set
`direction:` on that note to settle it:

```yaml
direction: rtl    # or ltr, or auto
```

Same key and same three values as the community Obsidian RTL plugin, so a vault
that already carries it keeps working. `auto` means the default per-block
behaviour, the same as leaving it out.

> **Tip.** A note that is entirely Persian on an English site gets every block
> marked. Setting `direction: rtl` on that note flips its own baseline, so only
> its English blocks are marked instead: the same rendering, fewer attributes.

Two limits. Obsidian detects direction per *line* and jotter per *block*, so a
paragraph whose lines run different ways is one direction here; `direction:` is
the escape hatch. And with `features.search` on, Pagefind indexes the whole site
under `locale`, so prose in a second language is stemmed with the wrong rules.
