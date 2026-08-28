/**
 * The scenario table from the direction plan, run in both site directions.
 *
 * Every row is asserted twice — once against an LTR site and once against an
 * RTL one — because the whole claim of the feature is that it is *symmetric*:
 * one rule, no second code path, and the majority language never marked
 * whichever one it is. A test that only ever ran the LTR side would pass
 * happily on an implementation that could only emit `rtl`, which is exactly the
 * bug `test/fixtures/vault/notes/English in Persian.md` exists to catch on the
 * rendering side.
 */
import { describe, expect, it } from 'vitest'

import { firstStrong, textDir, normalizeDirection } from '../src/lib/bidi.js'

describe('firstStrong', () => {
  it('reads Latin, Greek and Cyrillic as left-to-right', () => {
    expect(firstStrong("I'm Navid")).toBe('ltr')
    expect(firstStrong('Καλημέρα')).toBe('ltr')
    expect(firstStrong('Заметка')).toBe('ltr')
  })

  /**
   * Defect 1 of the plan's scenario pass, as a regression test. An earlier
   * draft enumerated the *LTR* scripts — Latin, Greek, Cyrillic — and these
   * four match none of them, so each would have found no strong character,
   * returned `undefined`, and on an RTL site inherited RTL. The list is
   * enumerated on the RTL side precisely so that a script nobody thought of is
   * left-to-right by default.
   */
  it('reads CJK, Devanagari, Thai and every unlisted script as left-to-right', () => {
    expect(firstStrong('这是一段中文')).toBe('ltr')
    expect(firstStrong('これは日本語です')).toBe('ltr')
    expect(firstStrong('한국어입니다')).toBe('ltr')
    expect(firstStrong('यह हिंदी है')).toBe('ltr')
    expect(firstStrong('นี่คือภาษาไทย')).toBe('ltr')
  })

  it('reads Persian, Arabic and Hebrew as right-to-left', () => {
    expect(firstStrong('اینجا محلی هست')).toBe('rtl')
    expect(firstStrong('نص عربي هنا')).toBe('rtl')
    expect(firstStrong('טקסט בעברית')).toBe('rtl')
  })

  /**
   * Defect 2. Thaana is Dhivehi, and N'Ko, Syriac, Samaritan, Mandaic, Adlam
   * and Hanifi Rohingya are RTL as well. An Arabic-plus-Hebrew test renders
   * every one of them the wrong way round and says nothing about it.
   */
  it('reads the RTL scripts that are neither Arabic nor Hebrew', () => {
    expect(firstStrong('ދިވެހި')).toBe('rtl') // Thaana
    expect(firstStrong('ߒߞߏ')).toBe('rtl') // N'Ko
    expect(firstStrong('ܠܫܢܐ ܣܘܪܝܝܐ')).toBe('rtl') // Syriac
    expect(firstStrong('𞤀𞤣𞤤𞤢𞤥')).toBe('rtl') // Adlam
  })

  /**
   * Digits are *weak* under the UBA — ASCII, Arabic-Indic and Extended
   * Arabic-Indic alike — so a line opening with a year resolves from the word
   * after it. This is why the test is letter-first and script-second: `۱۳۹۹`
   * is `Script=Arabic` but is not a letter, and treating it as strong would
   * make a bare number an RTL paragraph.
   */
  it('skips digits and resolves from the first letter', () => {
    expect(firstStrong('۱۳۹۹ سال خوبی بود')).toBe('rtl')
    expect(firstStrong('2026 مرور سال')).toBe('rtl')
    expect(firstStrong('١٩٩٩ عام جيد')).toBe('rtl')
    expect(firstStrong('2026 in review')).toBe('ltr')
  })

  it('skips punctuation, symbols, emoji and ZWNJ', () => {
    expect(firstStrong('«اینجا» محلی هست')).toBe('rtl')
    expect(firstStrong('— "quoted" text')).toBe('ltr')
    expect(firstStrong('🌱 seedling')).toBe('ltr')
    // ZWNJ is `\p{Cf}`: ubiquitous in Persian, and it votes for neither side.
    expect(firstStrong('‌یادداشت‌ها')).toBe('rtl')
  })

  it('has no answer for text with no strong character in it', () => {
    expect(firstStrong('')).toBeUndefined()
    expect(firstStrong('1234 5678')).toBeUndefined()
    expect(firstStrong('— (!!) …')).toBeUndefined()
    expect(firstStrong('🌱 ✳️ 🙂')).toBeUndefined()
    expect(firstStrong('‌')).toBeUndefined()
  })

  /** UBA P2 skips everything between an isolate initiator and its PDI. */
  it('skips an isolated run and resolves from what follows it', () => {
    expect(firstStrong('⁦Obsidian⁩ یک برنامه است')).toBe('rtl')
    expect(firstStrong('⁧اینجا⁩ is the note')).toBe('ltr')
    // An unterminated isolate swallows the rest, which is what P2 says to do.
    expect(firstStrong('⁦Obsidian یک برنامه است')).toBeUndefined()
  })

  /** LRM, RLM and ALM are strong under the UBA even though they are invisible. */
  it('honours an explicit direction mark', () => {
    expect(firstStrong('‏(2026)')).toBe('rtl')
    expect(firstStrong('‎(۱۳۹۹)')).toBe('ltr')
  })

  it('takes a mixed title from whichever script opens it', () => {
    expect(firstStrong('Radio Marz - رادیو مرز')).toBe('ltr')
    expect(firstStrong('رادیو مرز - Radio Marz')).toBe('rtl')
  })

  /**
   * The documented wrong answer, pinned deliberately. Obsidian's editor gets
   * this wrong in the same direction, which is the point: the published page
   * agrees with what the author saw while writing. `direction:` in the note's
   * frontmatter is the escape hatch. If this test ever goes red because
   * somebody has slipped in a majority-of-characters heuristic, the fix is not
   * to update the expectation.
   */
  it('gets a sentence opening with the other script wrong, exactly as Obsidian does', () => {
    expect(firstStrong('Obsidian یک برنامه است')).toBe('ltr')
  })
})

/**
 * The scenario table itself. `undefined` means "emit nothing", which is both
 * the zero-cost property and the majority-language rule.
 */
describe('textDir marks only what differs from the page', () => {
  const rows: Array<[string, string, ReturnType<typeof textDir>, ReturnType<typeof textDir>]> = [
    // description                     text                          on ltr   on rtl
    ['English prose', "I'm a guy who enjoys…", undefined, 'ltr'],
    ['Persian prose', 'اینجا محلی هست…', 'rtl', undefined],
    ['Arabic prose', 'نص عربي هنا…', 'rtl', undefined],
    ['Hebrew prose', 'טקסט בעברית', 'rtl', undefined],
    ['Chinese prose', '这是一段中文', undefined, 'ltr'],
    ['Hindi prose', 'यह हिंदी है', undefined, 'ltr'],
    ['Thai prose', 'นี่คือภาษาไทย', undefined, 'ltr'],
    ['Greek prose', 'Καλημέρα', undefined, 'ltr'],
    ['Dhivehi (Thaana)', 'ދިވެހި', 'rtl', undefined],
    ["N'Ko", 'ߒߞߏ', 'rtl', undefined],
    ['Syriac', 'ܠܫܢܐ ܣܘܪܝܝܐ', 'rtl', undefined],
    ['digits then Persian', '۱۳۹۹ سال خوبی بود', 'rtl', undefined],
    ['Western digits then Persian', '2026 مرور سال', 'rtl', undefined],
    ['punctuation then Persian', '«اینجا» محلی…', 'rtl', undefined],
    ['digits only', '1234 5678', undefined, undefined],
    ['punctuation only', '— (!!) …', undefined, undefined],
    ['emoji only', '🌱 ✳️', undefined, undefined],
    ['Radio Marz - رادیو مرز', 'Radio Marz - رادیو مرز', undefined, 'ltr'],
    ['رادیو مرز - Radio Marz', 'رادیو مرز - Radio Marz', 'rtl', undefined],
    ['the known-wrong case', 'Obsidian یک برنامه است', undefined, 'ltr'],
  ]

  for (const [label, text, onLtr, onRtl] of rows) {
    it(`${label}: ${onLtr ?? 'nothing'} on an LTR site, ${onRtl ?? 'nothing'} on an RTL one`, () => {
      expect(textDir(text, 'ltr')).toBe(onLtr)
      expect(textDir(text, 'rtl')).toBe(onRtl)
    })
  }

  /**
   * Stated once on its own, because it is the whole cost argument: a vault
   * written entirely in one script emits not a single attribute, in either
   * direction, so the build output is byte-identical to one without any of
   * this in it.
   */
  it('emits nothing at all for a vault that agrees with its site', () => {
    const english = ['A heading', 'A paragraph.', 'A list item']
    const persian = ['یک عنوان', 'یک بند.', 'یک مورد فهرست']
    expect(english.map((t) => textDir(t, 'ltr'))).toEqual([undefined, undefined, undefined])
    expect(persian.map((t) => textDir(t, 'rtl'))).toEqual([undefined, undefined, undefined])
  })
})

describe('normalizeDirection', () => {
  it('reads the three values the esm7 plugin writes, case-insensitively', () => {
    expect(normalizeDirection('rtl')).toBe('rtl')
    expect(normalizeDirection('LTR')).toBe('ltr')
    expect(normalizeDirection('  Auto ')).toBe('auto')
  })

  it('declines anything else, so the scan can warn about it by name', () => {
    expect(normalizeDirection('right')).toBeUndefined()
    expect(normalizeDirection('rtl-x')).toBeUndefined()
    expect(normalizeDirection('')).toBeUndefined()
    expect(normalizeDirection(true)).toBeUndefined()
    expect(normalizeDirection(undefined)).toBeUndefined()
    expect(normalizeDirection(null)).toBeUndefined()
  })
})
