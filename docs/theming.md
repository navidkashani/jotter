# Design and theming

`src/styles/tokens.css` is the whole visual system: OKLCH colours, two type
scales, space, radii, durations. Light on `:root`, dark under both
`[data-theme="dark"]` and `prefers-color-scheme`.

The palette is warm throughout, with neutrals on hue 60 and an ochre accent on
hue 70. The surface model is *raised*: `--surface` is lighter than `--paper`,
and anything lifted off the page carries a hairline `--rule` rather than a
shadow. There is no shadow token. `--soft`, the accent at 11% alpha, does the
tinting: nav hover, inline code, tag chips, `::selection`, link underlines.

Type runs at two scales. App chrome (header, nav, labels, lists) is `--step-ui`
(16/1.65), and note prose alone is `--step-body` (17/1.72). Titles are 38 for
the site, 33 for a note, 29 for an index and 19 for a section, with mono at 11.5
for data (`.meta`) and 10 uppercase for section labels (`.label`).

## Re-skinning it

The fastest way is to override tokens in `src/styles/custom.css` rather than
write rules:

```css
:root {
  --accent: oklch(50% 0.13 255);
  --accent-hover: oklch(40% 0.14 255);
  --soft: oklch(50% 0.13 255 / 0.11);
  --font-body: 'Your Face', serif;
  --measure: 72ch;
}
```

The build fails on a colour literal anywhere outside `tokens.css`.

Every rule in the theme uses logical properties, so `dir: 'rtl'` is a config
change and not a second stylesheet. The build fails if a physical property
sneaks in. Because the CSS is logical throughout, a block that runs the other
way flips its alignment, indents, list markers and quote bars for free. See
[frontmatter.md](frontmatter.md#mixed-direction-vaults).

To replace a component rather than restyle it, drop an `.astro` file into
`src/user/`. See [src/user/README.md](../src/user/README.md) for the slots and
their props.

## Accessibility

WCAG AA contrast on every token pair, in both themes, asserted at build. Visible
focus everywhere, a skip link, landmarks, `prefers-reduced-motion`, and a print
stylesheet.

The navigation tree, the outline, the drawer and every callout work with
JavaScript disabled. The only scripts in a default build are the theme island
and the drawer enhancement, about 1.1 KB together.

| Feature | What it adds per page |
| --- | --- |
| Default build | about 1.1 KB |
| `features.graph` | an 18 KB `d3-force` chunk on note pages, about 22 KB in all |
| `features.hoverPreview` | about 1.2 KB, no request, plus the excerpts in the markup |
| `features.search` | about 6 KB on every page, and nothing else until a reader opens it |

The graph keeps its own readable list of neighbours underneath it either way.
The search modal is keyboard-first, focus is trapped and returned, results are
real links, and the count is announced. With scripting off there is no search
button at all, because one that did nothing would be worse than none.

The per-page budget is asserted at 32 KB of jotter's own JavaScript. It was 24
KB until search shipped, and graph and search together measure 29,334 bytes on a
note page, so the ceiling moved once, deliberately.
`scripts/verify-build.mjs` says why.

A configured analytics provider's script is not counted against that budget,
because it is not a file in `dist/` and its weight is the vendor's. The build
reports the tag and its origin next to the number, so the exclusion is visible.
