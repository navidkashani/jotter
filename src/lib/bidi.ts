/**
 * Which way a piece of text runs, and whether that is worth saying out loud.
 *
 * jotter has always had exactly one direction for the whole site —
 * `config.dir`, spent in one place, on `<html>` — so a vault that mixes scripts
 * has no correct setting. An English site with Persian paragraphs in it renders
 * them left-aligned with their terminal punctuation thrown to the wrong end of
 * every line, and an Arabic site with English notes in it has the mirror
 * problem. There is no third setting that fixes either.
 *
 * The answer is per block, and it is one rule rather than two code paths:
 * **mark the blocks whose direction differs from the page's.** The majority
 * language is never marked, whichever one it is, which is what makes the
 * feature symmetric and what makes a single-script vault of *either* direction
 * pay exactly nothing — `textDir` returns `undefined`, Astro drops an
 * `undefined` attribute, and `ctx.setProperty` is never called.
 *
 * ## Why the answer is computed here rather than deferred to `dir="auto"`
 *
 * Obsidian Publish sets `dir="auto"` on every block and lets the browser run
 * the algorithm, because Publish *is* a browser renderer. jotter renders ahead
 * of time, so it emits the answer it already knows. Three consequences decide
 * it: `dir="auto"` is unassertable — a Persian paragraph and an English one
 * produce byte-identical markup, so no build check can tell a right answer from
 * a shrug; a single-script vault pays nothing here and would pay an attribute
 * per block there; and an explicit `dir` keeps the three existing `[dir='rtl']`
 * selectors in `base.css` matching, so no `:dir()` migration and no CSS.
 *
 * ## The rule
 *
 * Pure first-strong — UBA rules P2 and P3, the same rule `dir="auto"` runs and
 * the same one Obsidian's editor has used per line since 1.6. Agreeing with the
 * editor matters more than being cleverer than it: the published page then
 * always looks like what the author saw while writing. A majority-of-characters
 * rule was tried, and rejected for diverging from the editor (it was also 7×
 * slower).
 *
 * It gets exactly one case wrong — a sentence opening with a word from the
 * other script, `Obsidian یک برنامه است` — and Obsidian gets that wrong too.
 * The escape hatch is `direction:` in the note's frontmatter, below.
 *
 * Pure, DOM-free and `node:fs`-free, the rule `src/lib/social.ts`,
 * `src/lib/analytics.ts` and `src/lib/feed.ts` already state in their
 * docstrings: vitest runs `environment: 'node'` and there is no jsdom, so
 * everything decidable lives where a unit test can reach it.
 */

/** A resolved base direction. The same two values as `config.dir`. */
export type Direction = 'ltr' | 'rtl'

/**
 * What a note's `direction:` frontmatter may say. `auto` is the esm7 RTL
 * plugin's third value and means "the default per-block behaviour" — i.e.
 * exactly what not setting the key does.
 */
export type DirectionSetting = Direction | 'auto'

/**
 * The right-to-left scripts, enumerated — and everything else that is a letter
 * is left-to-right.
 *
 * This way round on purpose, and the way round an earlier draft had it was a
 * real bug. Enumerating the *LTR* scripts (Latin, Greek, Cyrillic) means
 * Chinese, Japanese, Korean, Devanagari and Thai match neither list, find no
 * strong character at all, and inherit — which on an RTL site renders a Chinese
 * paragraph right-to-left. Enumerating the RTL side instead makes every script
 * jotter has never heard of correct by default.
 *
 * Nine scripts rather than the two everybody remembers: Thaana is Dhivehi,
 * and N'Ko, Syriac, Samaritan, Mandaic, Adlam and Hanifi Rohingya are all RTL.
 * An Arabic-plus-Hebrew test renders every one of them the wrong way.
 */
const RTL_SCRIPT =
  /[\p{Script=Adlam}\p{Script=Arabic}\p{Script=Hanifi_Rohingya}\p{Script=Hebrew}\p{Script=Mandaic}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Syriac}\p{Script=Thaana}]/u

/**
 * Only letters vote.
 *
 * Digits are the case that matters: ASCII, Arabic-Indic (`U+0660`-`U+0669`) and
 * Extended Arabic-Indic (`U+06F0`-`U+06F9`) are all *weak* under the UBA, so
 * `۱۳۹۹ سال خوبی بود` must resolve from `سال` and not from its year. The last
 * two are `Script=Arabic` but not `\p{L}`, which is why the test is
 * letter-first and script-second rather than the other way round.
 *
 * Punctuation, symbols, emoji and combining marks are skipped for the same
 * reason, and so is ZWNJ (`U+200C`) — ubiquitous in Persian (`یادداشت‌ها`), and
 * `\p{Cf}` rather than a letter, so it matches neither class.
 */
const LETTER = /\p{L}/u

/** The three explicit direction marks: LRM, RLM and ALM. UBA classes L, R, AL. */
const LRM = 0x200e
const RLM = 0x200f
const ALM = 0x061c

/** Isolate initiators (LRI, RLI, FSI) and the PDI that closes them. */
const LRI = 0x2066
const RLI = 0x2067
const FSI = 0x2068
const PDI = 0x2069

/**
 * The base direction of a run of text, by UBA P2/P3: the first strong
 * character wins, and `undefined` when there is none.
 *
 * `undefined` is not a failure — it is the correct answer for a block of
 * digits, punctuation or emoji, which has no direction of its own and should
 * take the one it inherits.
 */
export function firstStrong(text: string): Direction | undefined {
  // P2 skips everything between an isolate initiator and its matching PDI:
  // an isolated run states its own direction and must not state the paragraph's.
  let isolated = 0

  for (const character of text) {
    const code = character.codePointAt(0)!

    if (code === LRI || code === RLI || code === FSI) {
      isolated++
      continue
    }
    if (code === PDI) {
      if (isolated > 0) isolated--
      continue
    }
    if (isolated > 0) continue

    if (code === LRM) return 'ltr'
    if (code === RLM || code === ALM) return 'rtl'

    if (!LETTER.test(character)) continue
    return RTL_SCRIPT.test(character) ? 'rtl' : 'ltr'
  }

  return undefined
}

/**
 * The `dir` this text needs, or `undefined` when it needs none.
 *
 * This one line is the whole zero-cost property of the feature: a block that
 * agrees with what it inherits is left exactly as it was, so a monolingual
 * vault — in either direction — produces byte-identical output to a build
 * without any of this.
 */
export function textDir(text: string, inherited: Direction): Direction | undefined {
  const own = firstStrong(text)
  return own === undefined || own === inherited ? undefined : own
}

/**
 * A note's `direction:` frontmatter, or `undefined` for anything unrecognised.
 *
 * The key, its spelling and its three values are the community RTL plugin's
 * (esm7), so a vault that already carries the key keeps working. `auto` is
 * accepted rather than warned about for exactly that reason: it is a value that
 * plugin writes, and it asks for the behaviour jotter does by default anyway.
 *
 * Returning `undefined` for a value it cannot read — rather than falling back
 * silently to `ltr` — is what lets `src/lib/vault.ts` tell "not set" from
 * "set to something I do not understand" and warn about the second, naming the
 * note and the value.
 */
export function normalizeDirection(value: unknown): DirectionSetting | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return normalized === 'rtl' || normalized === 'ltr' || normalized === 'auto'
    ? normalized
    : undefined
}
