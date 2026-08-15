/**
 * LlmStatsView tests (src/client/LlmStatsView.tsx): the model-requests
 * table must update INCREMENTALLY, not re-render wholesale on every poll.
 * Two layers are pinned:
 * - mergeCalls (the mechanism): a value-identical poll keeps the previous
 *   ARRAY identity (setState bails out — zero renders), and a poll that
 *   changes one row swaps only THAT row's object identity, so the
 *   React.memo row re-renders alone;
 * - the view (the behavior): a streaming row's stopwatch ticks with the
 *   fast poll, lands frozen once the call completes, and idle polls with
 *   identical wire payloads leave the table perfectly stable.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { LlmStatsView, mergeCalls, type LlmCallStat } from '../src/client/LlmStatsView.tsx'
import css from '../src/client/sidebar.module.css'

/** Controlled wire state: each poll deep-copies, like a real HTTP response
 *  would — fresh object identities on every call, value equality only. */
let wireCalls: LlmCallStat[] = []
const wireTotals = { calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...mod,
    api: {
      ...mod.api,
      llmStats: () => Promise.resolve({
        calls: wireCalls.map(call => ({ ...call })),
        totals: { ...wireTotals, calls: wireCalls.length },
      }),
    },
  }
})

/** Minimal valid row; per-test overrides. */
function stat(partial: Partial<LlmCallStat> & { key: string }): LlmCallStat {
  return { turn: 1, step: 1, startedAt: 0, status: 'done', ...partial }
}

/** Render `node` into a detached body container under React's act(). */
function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(node) })
  const unmount = (): void => {
    act(() => { root.unmount() })
    container.remove()
  }
  return { container, unmount }
}

/** Flush pending microtasks (the first refresh) inside act(). */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** All data rows currently in the table. */
function rowsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll(`table tbody tr`))
}

/** A row's duration cell (4th column: pos, time, ttft, DURATION, ...). */
function durationOf(row: HTMLElement): string {
  return row.children[3]?.textContent ?? ''
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

describe('mergeCalls: identity-preserving poll merge', () => {
  it('returns the PREVIOUS array reference when nothing changed', () => {
    const prev = [stat({ key: 'a', totalMs: 100 }), stat({ key: 'b', totalMs: 200 })]
    // Fresh wire objects with identical values.
    const next = prev.map(call => ({ ...call }))
    expect(mergeCalls(prev, next)).toBe(prev)
  })

  it('swaps identity ONLY for the row whose fields changed', () => {
    const a = stat({ key: 'a', totalMs: 100 })
    const b = stat({ key: 'b', totalMs: 200 })
    const next = [{ ...a }, stat({ key: 'b', totalMs: 250, outputTokens: 42 })]
    const merged = mergeCalls([a, b], next)
    expect(merged).not.toBe([a, b])
    expect(merged[0]).toBe(a) // untouched row keeps its identity → memo skips it
    expect(merged[1]).not.toBe(b)
    expect(merged[1]!.totalMs).toBe(250)
  })

  it('handles new rows sliding into the window (old rows keep identity)', () => {
    const a = stat({ key: 'a' })
    const merged = mergeCalls([a], [a, stat({ key: 'z', turn: 9 })])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toBe(a)
    expect(merged[1]!.key).toBe('z')
  })

  it('treats null prev (first poll) as a full adopt', () => {
    const next = [stat({ key: 'a' })]
    expect(mergeCalls(null, next)).toBe(next)
  })
})

describe('LlmStatsView: incremental table updates', () => {
  it('renders the rows and stays put across value-identical idle polls', async () => {
    wireCalls = [
      stat({ key: 'a', ttftMs: 300, totalMs: 1200, tokPerSec: 88.8, inputTokens: 1000, outputTokens: 300 }),
      stat({ key: 'b', ttftMs: 250, totalMs: 900 }),
    ]
    const { container, unmount } = mount(createElement(LlmStatsView, { scope: { sessionId: 's1' }, visible: true }))
    await flush()
    expect(rowsOf(container)).toHaveLength(2)

    // Two idle poll periods with IDENTICAL wire payloads: merge keeps the
    // array identity → setState bails out → no re-render churn at all.
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    const rows = rowsOf(container)
    expect(rows).toHaveLength(2)
    expect(durationOf(rows[0]!)).toBe('1.2s')
    expect(durationOf(rows[1]!)).toBe('0.9s')
    unmount()
  })

  it('a streaming row ticks its stopwatch, then freezes when done', async () => {
    const t0 = 1_000_000
    vi.setSystemTime(t0)
    wireCalls = [
      stat({ key: 's', turn: 3, step: 2, status: 'streaming', startedAt: t0 - 4_000 }),
      stat({ key: 'd', totalMs: 900 }),
    ]
    const { container, unmount } = mount(createElement(LlmStatsView, { scope: { sessionId: 's1' }, visible: true }))
    await flush()

    const rows = rowsOf(container)
    expect(rows[0]!.className).toContain(css.llmRowLive)
    expect(durationOf(rows[0]!)).toBe('4.0s') // wall clock since start

    // Fast-poll ticks advance ONLY the streaming row's stopwatch.
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(durationOf(rowsOf(container)[0]!)).toBe('4.5s')

    // The call completes: live styling drops, the final duration lands and
    // stays frozen however long the idle polls keep coming.
    wireCalls = [
      stat({ key: 's', turn: 3, step: 2, status: 'done', startedAt: t0 - 4_000, totalMs: 5_300, ttftMs: 400 }),
      stat({ key: 'd', totalMs: 900 }),
    ]
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    const landed = rowsOf(container)[0]!
    expect(landed.className).not.toContain(css.llmRowLive)
    expect(durationOf(landed)).toBe('5.3s')
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    expect(durationOf(rowsOf(container)[0]!)).toBe('5.3s')
    unmount()
  })

  it('a row arriving after the first window slides in; initial rows do not', async () => {
    wireCalls = [stat({ key: 'a', totalMs: 100 }), stat({ key: 'b', totalMs: 200 })]
    const { container, unmount } = mount(createElement(LlmStatsView, { scope: { sessionId: 's1' }, visible: true }))
    await flush()
    // First window: painted whole, no slide-in class on any row.
    for (const row of rowsOf(container)) {
      expect(row.className).not.toContain(css.llmRowIn)
    }

    // A new call lands (new key): ONLY its row carries the slide-in class —
    // the arrival reads as one row sliding in, not a table rebuild.
    wireCalls = [stat({ key: 'n', turn: 2, totalMs: 5 }), stat({ key: 'a', totalMs: 100 }), stat({ key: 'b', totalMs: 200 })]
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    const rows = rowsOf(container)
    expect(rows).toHaveLength(3)
    expect(rows[0]!.className).toContain(css.llmRowIn)
    expect(rows[1]!.className).not.toContain(css.llmRowIn)
    expect(rows[2]!.className).not.toContain(css.llmRowIn)
    unmount()
  })
})
