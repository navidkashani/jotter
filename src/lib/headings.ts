/**
 * The heading shape Astro's `render()` returns, named once so the outline
 * components and the note layout agree without importing types across `.astro`
 * boundaries.
 */
export interface Heading {
  depth: number
  slug: string
  text: string
}

/** h1 is the note title, already on the page; h5 and h6 are too fine to outline. */
export const outlineHeadings = (headings: readonly Heading[]): Heading[] =>
  headings.filter((h) => h.depth >= 2 && h.depth <= 4)
