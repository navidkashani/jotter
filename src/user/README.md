# Yours

Drop an `.astro` file in here and jotter renders it instead of its own.

| File | Replaces | Props |
| --- | --- | --- |
| `Header.astro` | `src/components/Header.astro` | none |
| `Sidebar.astro` | `src/components/Sidebar.astro` | `current?: string` |
| `Frontmatter.astro` | `src/components/Frontmatter.astro` | `note: VaultNote` |
| `PrevNext.astro` | `src/components/PrevNext.astro` | `previous?: VaultNote`, `next?: VaultNote` |
| `Head.astro` | nothing — renders last in `<head>` | none |
| `Footer.astro` | nothing — renders after `<main>` | none |

Nothing to register: the file's presence is the whole mechanism. Copy the
component you are replacing out of `src/components/` and edit the copy.

`Head.astro` is where a script tag goes — an analytics snippet a provider in
`jotter.config.ts` does not cover, a site-verification `<meta>`, a font. It used
to be `src/layouts/Base.astro`, which is one of the files upstream changes most,
so the advice put your code in the path most likely to conflict with every
update you take. **jotter never writes a file in this directory**, which is what
makes anything you put here safe from a merge.

This README is jotter's; deleting it is the one thing in here that can conflict.
Leave it, or take upstream's copy when it does.
