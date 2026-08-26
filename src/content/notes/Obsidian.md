---
title: Obsidian
tags: [tool]
created: 2026-02-02
updated: 2026-05-19
---

A markdown editor that stores notes as plain files in a folder you own.

Its two decisions that matter for publishing:

**Wikilinks.** `[[Note]]` links by *name*, resolved against the whole vault by
shortest path. Move the file and the link still works. This is why publishing
a vault is harder than it looks — a generator that sees only the published
subset cannot reproduce the resolution.

**Plain files.** There is no database and no lock-in. Which is exactly why
[[jotter]] can point at a folder and build a site from it.
