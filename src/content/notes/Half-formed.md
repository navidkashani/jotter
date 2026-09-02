---
title: A title that must never reach the site
publish: false
aliases: [The unfinished one]
tags: [meta]
---

This note is not published: it has `publish: false` in its frontmatter.

Other notes link to it. Those links render as inert dead-link spans labelled
with the *filename the author typed*, never with this note's own title, which
is why the title above is written the way it is. `scripts/verify-build.mjs`
asserts that string appears nowhere in `dist/`.
