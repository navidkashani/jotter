import { describe, expect, it } from 'vitest'
import { tokenizeInline, isInlinePlain } from '../src/lib/inline.js'

const text = (value: string) => ({ kind: 'text', value })

describe('tokenizeInline', () => {
  it('leaves plain text alone', () => {
    expect(tokenizeInline('just words')).toEqual([text('just words')])
  })

  it('strips inline comments', () => {
    expect(tokenizeInline('a %%hidden%% b')).toEqual([text('a  b')])
  })

  it('strips a comment spanning lines within one block', () => {
    expect(tokenizeInline('a %%one\ntwo%% b', { strictLineBreaks: true })).toEqual([text('a  b')])
  })

  it('marks a highlight', () => {
    expect(tokenizeInline('an ==important== idea')).toEqual([
      text('an '),
      { kind: 'mark', value: 'important' },
      text(' idea'),
    ])
  })

  it('ignores an empty or spaced highlight', () => {
    expect(tokenizeInline('a ==== b')).toEqual([text('a ==== b')])
    expect(tokenizeInline('2 == 2 is true')).toEqual([text('2 == 2 is true')])
  })

  it('finds tags, including nested ones', () => {
    expect(tokenizeInline('see #method/zettelkasten now')).toEqual([
      text('see '),
      { kind: 'tag', tag: 'method/zettelkasten' },
      text(' now'),
    ])
  })

  it('does not treat an all-numeric fragment or a mid-word hash as a tag', () => {
    expect(tokenizeInline('issue #123 here')).toEqual([text('issue #123 here')])
    expect(tokenizeInline('a#b')).toEqual([text('a#b')])
  })

  it('finds a tag after an opening bracket or quote', () => {
    expect(tokenizeInline('("#real")')).toEqual([
      text('("'),
      { kind: 'tag', tag: 'real' },
      text('")'),
    ])
  })

  it('turns soft newlines into breaks by default', () => {
    expect(tokenizeInline('one\ntwo')).toEqual([text('one'), { kind: 'break' }, text('two')])
  })

  it('keeps newlines as text under strictLineBreaks', () => {
    expect(tokenizeInline('one\ntwo', { strictLineBreaks: true })).toEqual([text('one\ntwo')])
  })

  it('handles all four syntaxes in one run, in order', () => {
    expect(tokenizeInline('a ==b== %%c%% #d\ne')).toEqual([
      text('a '),
      { kind: 'mark', value: 'b' },
      text('  '),
      { kind: 'tag', tag: 'd' },
      { kind: 'break' },
      text('e'),
    ])
  })

  it('lets a highlight win over a tag starting at the same place', () => {
    expect(tokenizeInline('==#tag==')).toEqual([{ kind: 'mark', value: '#tag' }])
  })

  it('honours the per-feature switches', () => {
    expect(tokenizeInline('#a ==b==', { tags: false, highlight: false })).toEqual([text('#a ==b==')])
  })
})

describe('isInlinePlain', () => {
  it('is a cheap gate matching the tokenizer', () => {
    expect(isInlinePlain('plain words')).toBe(true)
    expect(isInlinePlain('has #tag')).toBe(false)
    expect(isInlinePlain('has ==mark==')).toBe(false)
    expect(isInlinePlain('has %%c%%')).toBe(false)
    expect(isInlinePlain('has\nbreak')).toBe(false)
    expect(isInlinePlain('has\nbreak', { strictLineBreaks: true })).toBe(true)
  })
})
