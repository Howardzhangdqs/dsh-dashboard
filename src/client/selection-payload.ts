/**
 * Pure payload builders for the "add selection to conversation" popup in the
 * text viewers (markdown preview + the catch-all code viewer). Everything
 * here is string math — no React, no ctx — so the unit tests cover it
 * directly.
 *
 * Insert shape: ALWAYS a user-format substitution (the Side card setting
 * under the `code` viewer card; the default `@{path}{lines}` renders as an
 * @-reference carrying the line span). Placeholders — `{path}` (relative
 * to the session cwd), `{abspath}`, `{start}`/`{end}` (line numbers),
 * `{lines}` (the `:start` / `:start-end` suffix), `{selection}` (the
 * selected text, empty when it exceeds SELECTION_LIMIT) — are substituted
 * and every other character is kept verbatim; `\n` escapes become
 * newlines. An EMPTY format resolves to the default (an empty insert is
 * never useful).
 *
 * The markdown preview cannot map rendered DOM back to source lines
 * directly, so it reverse-searches the selected text in the source and
 * only reports lines on an unambiguous hit (see {@link linesOfSelection}).
 */
import { SELECTION_FORMAT_DEFAULT } from '../prefs-shared.ts'
import { relativeTo } from './paths.ts'

/** Max inserted selection length (UTF-16 code units, i.e. JS `.length`). */
export const SELECTION_LIMIT = 500

/** The placeholder keys a format string understands. */
export const SELECTION_PLACEHOLDERS = ['path', 'abspath', 'start', 'end', 'lines', 'selection'] as const

/** The source line span a selection maps to (1-based, inclusive). */
export interface SelectionLines {
  start: number
  end: number
}

/** One placeholder's substituted value. */
function selectionValues(
  path: string,
  cwd: string | undefined,
  lines: SelectionLines | undefined,
  selected: string,
): Record<(typeof SELECTION_PLACEHOLDERS)[number], string> {
  const rel = cwd !== undefined ? relativeTo(cwd, path) : path
  return {
    path: rel,
    abspath: path,
    start: lines === undefined ? '' : String(lines.start),
    end: lines === undefined ? '' : String(lines.end),
    lines: lines === undefined ? '' : lines.end > lines.start ? `:${lines.start}-${lines.end}` : `:${lines.start}`,
    selection: selected.length <= SELECTION_LIMIT ? selected : '',
  }
}

/**
 * Build the insert from a format string. Placeholders are substituted
 * (unknown `{...}` tokens are kept verbatim, so typos stay visible); a
 * literal `\n` escape becomes a newline and `$` inside substituted values
 * is never treated specially. An EMPTY format resolves to the default
 * `@{path}{lines}` @-reference (an empty insert is never useful).
 */
export function formatSelectionInsert(
  path: string,
  cwd: string | undefined,
  lines: SelectionLines | undefined,
  selected: string,
  format: string,
): string {
  const values = selectionValues(path, cwd, lines, selected)
  const pattern = new RegExp(`\\{(${SELECTION_PLACEHOLDERS.join('|')})\\}`, 'g')
  return (format === '' ? SELECTION_FORMAT_DEFAULT : format)
    .replace(/\\n/g, '\n')
    .replace(pattern, (_match, key: (typeof SELECTION_PLACEHOLDERS)[number]) => values[key])
}

/**
 * The full text appended to the composer draft for one selection: the
 * Side card's format string (absent/empty falls back to the default
 * `@{path}{lines}` @-reference). The markdown preview shares the popup.
 */
export function buildSelectionInsert(
  path: string,
  cwd: string | undefined,
  lines: SelectionLines | undefined,
  selected: string,
  format = SELECTION_FORMAT_DEFAULT,
): string {
  return formatSelectionInsert(path, cwd, lines, selected, format)
}

/** 1-based line number of a character index in a text. */
function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++
  }
  return line
}

/**
 * Reverse-map a rendered-DOM selection back to source line numbers. The
 * preview selection is plain text (block boundaries come out as `\n`), so
 * this is a best-effort substring search: a single trailing newline is
 * stripped first (DOM block selections tend to carry one), and only an
 * EXACTLY-ONE occurrence yields lines — an ambiguous or missing match
 * returns null (the insert then carries no line numbers).
 */
export function linesOfSelection(source: string, selected: string): SelectionLines | null {
  const text = selected.endsWith('\n') ? selected.slice(0, -1) : selected
  if (text === '') return null
  const at = source.indexOf(text)
  if (at === -1) return null
  if (source.indexOf(text, at + 1) !== -1) return null
  return {
    start: lineAt(source, at),
    end: lineAt(source, at + Math.max(text.length - 1, 0)),
  }
}
