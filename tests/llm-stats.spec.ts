/**
 * Host route tests for the model-call metrics API ('llm.stats'): per-call
 * derivation of TTFT / duration / generation phase / tok-s / cache fields
 * from the session's own event log, the live mirror merge (dedupe by
 * turn:step), and the ordering / limit / unknown-session behavior.
 */
import { describe, expect, it } from 'vitest'
import { buildLlmStatsApi } from '../src/llm-stats.ts'
import type { Context, SidebarSessionEvent } from '../src/context-types.ts'

/** A context whose session store serves the given events (no live feed). */
function ctxWith(events: SidebarSessionEvent[]): Context {
  return {
    sessions: { get: () => ({ header: { cwd: '/p' }, events }) },
    get: () => undefined,
  } as unknown as Context
}

/** A context that additionally captures the session/event listener (live mirror). */
function ctxWithFeed(events: SidebarSessionEvent[]): {
  ctx: Context
  emit: (event: SidebarSessionEvent) => void
} {
  let listener: ((session: unknown, event: SidebarSessionEvent) => void) | undefined
  const base = ctxWith(events) as unknown as {
    on: (event: string, fn: (session: unknown, event: SidebarSessionEvent) => void) => () => void
    effect: (fn: () => void | (() => void)) => void
  }
  base.on = (_event, fn) => {
    listener = fn
    return () => { if (listener === fn) listener = undefined }
  }
  // The vendored cordis runs the registration effect immediately.
  base.effect = (fn) => { fn() }
  return {
    ctx: base as unknown as Context,
    emit: (event) => { listener?.({ id: 's1' }, event) },
  }
}

/** One session event factory (seq/time both advance by the given values). */
function ev(type: string, seq: number, time: number, data: Record<string, unknown>): SidebarSessionEvent {
  return { type, seq, time, data }
}

/** A complete model call: step/start → chunks → assistant/message → step/end. */
function modelCall(over: {
  turn: number
  step: number
  t0: number
  firstChunk: number
  lastChunk: number
  end: number
  usage?: Record<string, number>
  model?: string
  provider?: string
}): SidebarSessionEvent[] {
  return [
    ev('step/start', 0, over.t0, { turn: over.turn, step: over.step }),
    ev('assistant/chunk', 1, over.firstChunk, { turn: over.turn, step: over.step, chunk: { type: 'block-start', block: { type: 'text' } } }),
    ev('assistant/chunk', 2, over.lastChunk, {
      turn: over.turn,
      step: over.step,
      chunk: { type: 'usage', usage: over.usage ?? { inputTokens: 1000, outputTokens: 240 } },
    }),
    ev('assistant/message', 3, over.lastChunk + 2, {
      turn: over.turn,
      step: over.step,
      usage: over.usage ?? { inputTokens: 1000, outputTokens: 240 },
      message: {
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: over.provider ?? 'p1', model: over.model ?? 'm-1' },
      },
    }),
    ev('step/end', 4, over.end, { turn: over.turn, step: over.step }),
  ]
}

describe('llm.stats route (event replay)', () => {
  it('derives TTFT, duration, generation phase, tok/s, and usage per call', () => {
    const api = buildLlmStatsApi(ctxWith(modelCall({ turn: 1, step: 1, t0: 1000, firstChunk: 2500, lastChunk: 4900, end: 5200 })))
    const { calls } = api.stats({ sessionId: 's1' })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.ttftMs).toBe(1500)          // first chunk − start
    expect(call.totalMs).toBe(3900)         // last chunk − start
    expect(call.genMs).toBe(2400)           // last − first chunk (diagnostic)
    expect(call.tokPerSec).toBe(61.5)       // 240 tokens / 3.9s TOTAL (TTFT included)
    expect(call.inputTokens).toBe(1000)
    expect(call.outputTokens).toBe(240)
    expect(call.model).toBe('m-1')
    expect(call.provider).toBe('p1')
    expect(call.status).toBe('done')
  })

  it('reports cache hits from the disjoint cache fields and keeps billed input separate', () => {
    const api = buildLlmStatsApi(ctxWith(modelCall({
      turn: 1, step: 1, t0: 0, firstChunk: 100, lastChunk: 200, end: 300,
      usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 9000, cacheWriteTokens: 1000 },
    })))
    const { calls } = api.stats({ sessionId: 's1' })
    expect(calls[0]!.inputTokens).toBe(500)
    expect(calls[0]!.cacheReadTokens).toBe(9000)
    expect(calls[0]!.cacheWriteTokens).toBe(1000)
  })

  it('marks a call streaming before its message/step end arrives', () => {
    const events = [
      ev('step/start', 0, 100, { turn: 2, step: 3 }),
      ev('assistant/chunk', 1, 400, { turn: 2, step: 3, chunk: { type: 'block-start', block: { type: 'text' } } }),
    ]
    const api = buildLlmStatsApi(ctxWith(events))
    const { calls } = api.stats({ sessionId: 's1' })
    expect(calls[0]!.status).toBe('streaming')
    expect(calls[0]!.ttftMs).toBe(300)
    expect(calls[0]!.inputTokens).toBeUndefined()
  })

  it('returns the newest calls first and honors the limit', () => {
    const events = [
      ...modelCall({ turn: 1, step: 1, t0: 1000, firstChunk: 1100, lastChunk: 1200, end: 1300 }),
      ...modelCall({ turn: 2, step: 1, t0: 5000, firstChunk: 5100, lastChunk: 5200, end: 5300 }),
      ...modelCall({ turn: 3, step: 1, t0: 9000, firstChunk: 9100, lastChunk: 9200, end: 9300 }),
    ]
    const api = buildLlmStatsApi(ctxWith(events))
    const all = api.stats({ sessionId: 's1' }).calls
    expect(all.map((c) => c.turn)).toEqual([3, 2, 1])
    const limited = api.stats({ sessionId: 's1', limit: 2 }).calls
    expect(limited.map((c) => c.turn)).toEqual([3, 2])
    // Totals stay whole-log regardless of the row limit.
    const page = api.stats({ sessionId: 's1', limit: 1 })
    expect(page.totals.calls).toBe(3)
    expect(page.totals.inputTokens).toBe(3000)
    expect(page.totals.outputTokens).toBe(720)
  })

  it('whole-log totals match the DSH status formula (cacheRead / billed input)', () => {
    // A cold call (write-heavy) + a warm call (read-heavy): the whole-log
    // hit rate must land between them, like DSH's own status line.
    const events = [
      ...modelCall({
        turn: 1, step: 1, t0: 1000, firstChunk: 1100, lastChunk: 1200, end: 1300,
        usage: { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 9000 },
      }),
      ...modelCall({
        turn: 2, step: 1, t0: 5000, firstChunk: 5100, lastChunk: 5200, end: 5300,
        usage: { inputTokens: 200, outputTokens: 200, cacheReadTokens: 9800 },
      }),
    ]
    const api = buildLlmStatsApi(ctxWith(events))
    const { totals } = api.stats({ sessionId: 's1' })
    // billed = 1000+9000 + 200+9800 = 20000; hits = 9800 → 49%.
    expect(totals.cacheWriteTokens).toBe(9000)
    expect(totals.cacheReadTokens).toBe(9800)
    const billed = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
    expect(billed).toBe(20000)
    expect(Math.round(totals.cacheReadTokens / billed * 1000) / 10).toBe(49)
  })

  it('merges the store seed with the live mirror, deduped by turn:step', () => {
    // Seed: a finished call plus a call whose stream continues live.
    const seed = [
      ...modelCall({ turn: 1, step: 1, t0: 1000, firstChunk: 1100, lastChunk: 1200, end: 1300 }),
      ev('step/start', 10, 5000, { turn: 2, step: 1 }),
      ev('assistant/chunk', 11, 5200, { turn: 2, step: 1, chunk: { type: 'block-start', block: { type: 'text' } } }),
    ]
    const feed = ctxWithFeed(seed)
    const api = buildLlmStatsApi(feed.ctx)
    // The live mirror sees the rest of turn 2's stream.
    feed.emit(ev('assistant/chunk', 12, 7000, {
      turn: 2, step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 200, outputTokens: 90 } },
    }))
    feed.emit(ev('assistant/message', 13, 7010, {
      turn: 2, step: 1,
      usage: { inputTokens: 200, outputTokens: 90 },
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'p1', model: 'm-1' } },
    }))
    feed.emit(ev('step/end', 14, 7100, { turn: 2, step: 1 }))
    const { calls } = api.stats({ sessionId: 's1' })
    expect(calls).toHaveLength(2)
    const live = calls.find((c) => c.turn === 2)
    expect(live?.status).toBe('done')
    expect(live?.ttftMs).toBe(200)
    expect(live?.totalMs).toBe(2000)
    expect(live?.outputTokens).toBe(90)
    expect(live?.genMs).toBe(1800) // seed first chunk 5200 → mirror last chunk 7000
    expect(live?.tokPerSec).toBe(45) // 90 tokens / 2.0s TOTAL (TTFT included)
  })

  it('falls back to provider/model from request/context when the message carries none', () => {
    const events = [
      ev('request/context', 0, 1, { provider: 'ctx-provider', model: 'ctx-model', contextWindow: 128000 }),
      ...modelCall({ turn: 1, step: 1, t0: 1000, firstChunk: 1100, lastChunk: 1200, end: 1300 }),
    ]
    // Strip the message source: the fallback path must kick in.
    for (const e of events) {
      if (e.type === 'assistant/message') {
        (e.data as { message?: unknown }).message = { role: 'assistant', content: [] }
      }
    }
    const api = buildLlmStatsApi(ctxWith(events))
    const { calls } = api.stats({ sessionId: 's1' })
    expect(calls[0]!.provider).toBe('ctx-provider')
    expect(calls[0]!.model).toBe('ctx-model')
    expect(calls[0]!.contextWindow).toBe(128000)
  })

  it('reports an empty list (not an error) for a known session without calls', () => {
    const api = buildLlmStatsApi(ctxWith([]))
    expect(api.stats({ sessionId: 's1' }).calls).toEqual([])
  })

  it('rejects a missing sessionId', () => {
    const api = buildLlmStatsApi(ctxWith([]))
    expect(() => api.stats({})).toThrow(/sessionId/)
  })

  it('rejects an unknown session with no mirror data', () => {
    const ctx = {
      sessions: { get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const api = buildLlmStatsApi(ctx)
    expect(() => api.stats({ sessionId: 'ghost' })).toThrow(/unknown session/)
  })
})
