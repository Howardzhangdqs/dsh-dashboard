/**
 * Pure payload logic for the viewer selection popup ("add to
 * conversation"): the format-string substitution (placeholders, \n
 * escapes, the empty-falls-back-to-default rule) and the best-effort
 * reverse-search that maps a preview selection back to source lines.
 */
import { describe, expect, it } from 'vitest'
import { SELECTION_FORMAT_DEFAULT } from '../src/prefs-shared.ts'
import {
  SELECTION_LIMIT,
  buildSelectionInsert,
  formatSelectionInsert,
  linesOfSelection,
} from '../src/client/selection-payload.ts'

describe('formatSelectionInsert (the format string substitution)', () => {
  it('substitutes every placeholder and resolves the \\n escape', () => {
    expect(formatSelectionInsert('/p/src/a.ts', '/p', { start: 2, end: 4 }, 'const x = 1', 'see {path} {start}-{end}:\n{selection}'))
      .toBe('see src/a.ts 2-4:\nconst x = 1')
  })

  it('{lines} carries the :start / :start-end suffix and empties when the lines are unknown', () => {
    expect(formatSelectionInsert('/p/a.ts', '/p', { start: 5, end: 5 }, 'x', '{path}{lines}')).toBe('a.ts:5')
    expect(formatSelectionInsert('/p/a.ts', '/p', { start: 5, end: 9 }, 'x', '{path}{lines}')).toBe('a.ts:5-9')
    expect(formatSelectionInsert('/p/a.ts', '/p', undefined, 'x', '{path}{lines}')).toBe('a.ts')
    expect(formatSelectionInsert('/p/a.ts', '/p', undefined, 'x', '[{start}/{end}]')).toBe('[/]')
  })

  it('empties {selection} when the selection is over the limit', () => {
    const huge = 'x'.repeat(SELECTION_LIMIT + 1)
    expect(formatSelectionInsert('/p/a.ts', '/p', { start: 2, end: 2 }, huge, '{path}{lines} => {selection}'))
      .toBe('a.ts:2 => ')
    // A selection exactly at the limit still carries.
    const edge = 'x'.repeat(SELECTION_LIMIT)
    expect(formatSelectionInsert('/p/a.ts', '/p', { start: 2, end: 2 }, edge, '{selection}')).toBe(edge)
  })

  it('projects {path} relative to the cwd and keeps {abspath} absolute', () => {
    expect(formatSelectionInsert('/p/d/a.ts', '/p', undefined, 'x', '{path}|{abspath}')).toBe('d/a.ts|/p/d/a.ts')
    // Unknown cwd: {path} falls back to the absolute form.
    expect(formatSelectionInsert('/p/d/a.ts', undefined, undefined, 'x', '{path}|{abspath}')).toBe('/p/d/a.ts|/p/d/a.ts')
  })

  it('keeps unknown placeholders, literal braces and $ characters verbatim', () => {
    expect(formatSelectionInsert('/p/a.ts', '/p', { start: 1, end: 1 }, 'v$1', '{foo} { {path} } $&')).toBe('{foo} { a.ts } $&')
    // A selection containing $ patterns is inserted literally (function-
    // callback replace never interprets them).
    expect(formatSelectionInsert('/p/a.ts', '/p', { start: 1, end: 1 }, '$& $1 $$', '{selection}')).toBe('$& $1 $$')
  })

  it('a format without placeholders passes through with only the \\n escape applied', () => {
    expect(formatSelectionInsert('/p/a.ts', '/p', undefined, 'x', 'line one\\nline two')).toBe('line one\nline two')
  })
})

describe('buildSelectionInsert (the popup payload entry)', () => {
  it('defaults to the @-reference format: @相对路径:行号', () => {
    expect(SELECTION_FORMAT_DEFAULT).toBe('@{path}{lines}')
    expect(buildSelectionInsert('/p/src/a.ts', '/p', { start: 12, end: 15 }, 'const x = 1')).toBe('@src/a.ts:12-15')
    expect(buildSelectionInsert('/p/src/a.ts', '/p', { start: 7, end: 7 }, 'x')).toBe('@src/a.ts:7')
    expect(buildSelectionInsert('/p/src/a.ts', '/p', undefined, 'x')).toBe('@src/a.ts')
    // Unknown cwd: the @-reference falls back to the absolute path.
    expect(buildSelectionInsert('/p/src/a.ts', undefined, { start: 3, end: 3 }, 'x')).toBe('@/p/src/a.ts:3')
  })

  it('an EMPTY stored format resolves to the default (an empty insert is never useful)', () => {
    expect(buildSelectionInsert('/p/a.ts', '/p', { start: 2, end: 4 }, 'x', '')).toBe('@a.ts:2-4')
    expect(formatSelectionInsert('/p/a.ts', '/p', { start: 2, end: 4 }, 'x', '')).toBe('@a.ts:2-4')
  })

  it('delegates to the custom format verbatim', () => {
    expect(buildSelectionInsert('/p/src/a.ts', '/p', { start: 2, end: 4 }, 'const x = 1', '{abspath}:{start}\n{selection}'))
      .toBe('/p/src/a.ts:2\nconst x = 1')
  })
})

describe('linesOfSelection', () => {
  const source = 'alpha\nbeta\ngamma alpha\ndelta\n'

  it('maps a unique hit to its source line span', () => {
    expect(linesOfSelection(source, 'beta')).toEqual({ start: 2, end: 2 })
    expect(linesOfSelection(source, 'gamma alpha')).toEqual({ start: 3, end: 3 })
  })

  it('spans the end line when the selection crosses line breaks', () => {
    expect(linesOfSelection(source, 'beta\ngamma')).toEqual({ start: 2, end: 3 })
  })

  it('returns null when the text is missing from the source', () => {
    expect(linesOfSelection(source, 'nope')).toBeNull()
  })

  it('returns null on an ambiguous (multi-hit) match', () => {
    expect(linesOfSelection(source, 'alpha')).toBeNull()
  })

  it('strips a single trailing newline before searching (DOM block selections)', () => {
    expect(linesOfSelection(source, 'delta\n')).toEqual({ start: 4, end: 4 })
  })

  it('returns null for an empty selection', () => {
    expect(linesOfSelection(source, '')).toBeNull()
    expect(linesOfSelection(source, '\n')).toBeNull()
  })
})
