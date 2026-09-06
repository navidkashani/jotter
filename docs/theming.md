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

### Direction

`dir: 'rtl'` is a config change and not a second stylesheet. Every rule in the
theme uses logical properties, and the build fails if a physical one sneaks in.

Logical properties are what makes that possible; they are not on their own what
makes it *true*. Four things need saying explicitly, and jotter says them:

- **Per-block overrides.** A vault that mixes scripts has blocks running against
  the page, marked with their own `dir` (see
  [frontmatter.md](frontmatter.md#mixed-direction-vaults)). Rules that must see
  those are written with `:dir()`, which matches an element's *resolved*
  direction. An ancestor `[dir='rtl'] …` cannot: it only ever matches
  `<html dir>`. The attribute form is kept for `.nav-tree` and `.sidebar`, which
  are chrome and can only ever take the site's direction.
- **Text built in the browser.** A hover preview card, a canvas label and a
  search result are assembled by script, where no CSS box model is involved and
  nothing is inherited from the note the words came from. Where the text is known
  at build time it travels with an explicit direction; where it is not, which is
  only the search excerpts, `unicode-bidi: plaintext` runs the same rule per
  paragraph in the browser.
- **Glyphs that must not mirror.** A media control tracks playback, not text, so
  the video play triangle is drawn with a `clip-path` whose percentages are
  physical. The transclusion arrow is the opposite case and *does* flip. The
  external-link `↗` deliberately does not.
- **Script typography.** Arabic and Persian are cursive, and `letter-spacing`
  pulls the joins between letters apart; the script's own mechanism is elongation
  instead. The tracking tokens are turned off and the tighter leading tokens
  loosened under `:dir(rtl)` in `tokens.css`, which reaches every rule that spends
  them, per block included.

A block that runs the other way then flips its alignment, indents, list markers
and quote bars, and a Persian heading inside an English page gets the same
treatment a wholly Persian site gets.

Chrome text is translated from `src/i18n/<code>.json`; `en.json` and `fa.json`
ship, and adding a locale is dropping a file in beside them. Dates follow
`locale`, so `fa-IR` renders `۱۵ شهریور ۱۴۰۵`: Jalali, with Persian digits. The
machine-readable `<time datetime>` stays Gregorian ISO, which is what the
attribute is defined to carry.

Search is indexed with Pagefind's `forceLanguage`, deliberately, because jotter
is a single-locale theme: prose in a second language is stemmed with the site's
rules. That is a known limit rather than an oversight; see
[frontmatter.md](frontmatter.md#mixed-direction-vaults) and the rationale in
`src/integrations/search.ts`.

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
