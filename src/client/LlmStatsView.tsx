/**
 * The LLM stats tab page: the session's recent MODEL API REQUESTS as a
 * compact TABLE — one row per call, columns for TTFT, duration, tok/s,
 * input/output tokens, and cache-hit rate, with a summary strip on top.
 * Data arrives from the host's 'llm.stats' route (a zero-write replay of
 * the session's own event log plus the live append mirror — see
 * src/llm-stats.ts); the view polls once a second WHILE VISIBLE (the tab
 * contract's `visible` flag pauses hidden tabs) so an in-flight request
 * grows its numbers live. Full per-call detail (model, provider, cache
 * read/write split, context-window usage) rides each row's title tooltip.
 *
 * LIVENESS: token counts arrive only in the provider's end-of-stream usage
 * chunk, but everything else updates live — the host mirrors session events
 * as they append, and the view polls adaptively (~250ms while any call is
 * streaming): a request's row appears the moment it starts (pulse dot),
 * TTFT lands with the first chunk, and the duration cell runs as a live
 * stopwatch until the call finishes.
 *
 * INCREMENTAL RENDERING: polls arrive constantly, but the table must not
 * re-render wholesale on each one. Four mechanisms keep updates surgical:
 * (1) each poll is MERGED into the previous list field-wise, so unchanged
 * rows keep their old object identity (and an entirely-unchanged poll
 * keeps the old ARRAY identity, which makes setState bail out — idle
 * polling costs zero renders); (2) rows are React.memo components, so a
 * new object lands only on the rows whose fields actually changed; (3)
 * the stopwatch clock `now` is threaded ONLY into streaming rows — the
 * ticking re-renders just that one row, never the table; (4) the poll
 * loop's identities key on the scope's PRIMITIVE fields — the shell
 * rebuilds the `scope` object every parent render, and keying on it
 * would abort/refetch/reset the cadence on each of those renders (a
 * bursty storm while a request streams). A row appearing after the
 * first window additionally slides in (.llmRowIn) so an arrival reads
 * as one new call, not a table rebuild.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, SidebarApiError, type SessionScope } from './api.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** One model call's metrics (wire mirror of the host's LlmCallStat). */
export interface LlmCallStat {
  key: string
  turn: number
  step: number
  startedAt: number
  ttftMs?: number
  totalMs?: number
  genMs?: number
  tokPerSec?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  provider?: string
  model?: string
  contextWindow?: number
  status: 'streaming' | 'done'
}

/** Poll cadence: fast while a request is streaming (event-level liveness),
 *  relaxed once idle. */
const POLL_FAST_MS = 250
const POLL_IDLE_MS = 700
const MAX_CALLS = 30

/** Always seconds, one decimal: `0.8s` / `2.3s` / `95.4s` — a single
 *  unit keeps the duration and TTFT columns vertically comparable. */
function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return '–'
  return `${(ms / 1000).toFixed(1)}s`
}

/** `18.4k` / `1.2M` — compact token counts. */
function fmtTok(n: number | undefined): string {
  if (n === undefined) return '–'
  if (n < 10_000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Wall-clock time of the call's start (`HH:mm:ss`, locale-formatted). */
function fmtTime(at: number): string {
  const d = new Date(at)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** Billed input (uncached + cache read + cache write). */
function billedOf(call: LlmCallStat): number | undefined {
  const billed = (call.inputTokens ?? 0) + (call.cacheReadTokens ?? 0) + (call.cacheWriteTokens ?? 0)
  return billed > 0 ? billed : undefined
}

/** Cache-HIT rate over billed input: hits are cache READS only. A cache
 *  WRITE is a first-time miss (the write-only cold request of a
 *  conversation), so counting writes as hits made cold requests read
 *  "100%". Undefined when the provider reports no cache fields at all. */
function cacheRate(call: LlmCallStat): number | undefined {
  const read = call.cacheReadTokens ?? 0
  const write = call.cacheWriteTokens ?? 0
  if (read === 0 && write === 0) return undefined
  const billed = billedOf(call)
  if (billed === undefined) return undefined
  return read / billed
}

/** Whole-log token totals (DSH's own status window). */
interface LlmTotals {
  calls: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** Field-wise equality for one call row. The heart of incremental
 *  rendering: a poll that changes a row's values must still avoid
 *  fabricating a new identity for the rows it did NOT change. */
function callStatEqual(a: LlmCallStat, b: LlmCallStat): boolean {
  return a.key === b.key
    && a.turn === b.turn
    && a.step === b.step
    && a.startedAt === b.startedAt
    && a.ttftMs === b.ttftMs
    && a.totalMs === b.totalMs
    && a.genMs === b.genMs
    && a.tokPerSec === b.tokPerSec
    && a.inputTokens === b.inputTokens
    && a.outputTokens === b.outputTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens
    && a.provider === b.provider
    && a.model === b.model
    && a.contextWindow === b.contextWindow
    && a.status === b.status
}

/** Merge a fresh poll into the previous list, PRESERVING row identity:
 *  a row whose fields are unchanged keeps the old object reference (so
 *  the memoized row component skips it), and if NOTHING changed the
 *  previous ARRAY reference is returned, which makes setCalls bail out
 *  before scheduling any render at all. Exported for tests — this merge
 *  is the contract that keeps polling cheap. */
export function mergeCalls(prev: LlmCallStat[] | null, next: LlmCallStat[]): LlmCallStat[] {
  if (prev === null) return next
  const byKey = new Map(prev.map(call => [call.key, call] as const))
  let changed = false
  const merged = next.map(call => {
    const old = byKey.get(call.key)
    if (old !== undefined && callStatEqual(old, call)) return old
    changed = true
    return call
  })
  return changed ? merged : prev
}

/** Totals counterpart of callStatEqual — keeps the summary strip's state
 *  reference stable across value-identical polls. */
function totalsEqual(a: LlmTotals | null, b: LlmTotals): boolean {
  return a !== null
    && a.calls === b.calls
    && a.inputTokens === b.inputTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens
    && a.outputTokens === b.outputTokens
}

/** One memoized table row. It re-renders only when mergeCalls swaps its
 *  `call` identity (some field of THIS row changed) or — streaming rows
 *  only — when the `now` stopwatch prop ticks. Idle rows always receive
 *  `now === undefined`, so the 250ms live clock can never touch them.
 *  `fresh` marks a row that appeared after the first window: a one-shot
 *  slide-in animation (see .llmRowIn) makes its arrival legible. */
const LlmCallRow = memo(function LlmCallRow(props: { call: LlmCallStat; now?: number; fresh?: boolean }): React.ReactNode {
  const { call, now, fresh } = props
  const rate = cacheRate(call)
  const billed = billedOf(call)
  const ctxPct = call.contextWindow !== undefined && billed !== undefined
    ? Math.min(100, Math.round(billed / call.contextWindow * 100))
    : undefined
  const tooltip = [
    call.model ?? t('llmUnknownModel'),
    call.provider,
    `T${call.turn}·S${call.step}`,
    t('llmCacheDetail', { read: fmtTok(call.cacheReadTokens), write: fmtTok(call.cacheWriteTokens) }),
    ctxPct !== undefined ? t('llmContextUsed', { pct: ctxPct }) : undefined,
  ].filter(Boolean).join(' · ')
  // Live stopwatch: a streaming row's duration grows with `now`
  // (wall clock since start) until the final samples land.
  const duration = call.status === 'streaming'
    ? Math.max(call.totalMs ?? 0, (now ?? Date.now()) - call.startedAt)
    : call.totalMs
  return (
    <tr
      className={[
        call.status === 'streaming' ? css.llmRowLive : undefined,
        fresh === true ? css.llmRowIn : undefined,
      ].filter(Boolean).join(' ') || undefined}
      title={tooltip}
    >
      <td className={css.llmTdLeft}>
        <span className={css.llmPos}>
          {call.status === 'streaming' && <span className={css.llmLiveDot} aria-label="streaming" />}
          {call.turn}:{call.step}
        </span>
      </td>
      <td className={css.llmTd}>{fmtTime(call.startedAt)}</td>
      <td className={css.llmTd}>{fmtMs(call.ttftMs)}</td>
      <td className={css.llmTd}>{fmtMs(duration)}</td>
      <td className={css.llmTd}>{call.tokPerSec !== undefined ? call.tokPerSec.toFixed(1) : '–'}</td>
      <td className={css.llmTd}>{fmtTok(billed)}</td>
      <td className={css.llmTd}>{fmtTok(call.outputTokens)}</td>
      <td className={css.llmTd}>{rate !== undefined ? `${Math.round(rate * 1000) / 10}%` : '–'}</td>
    </tr>
  )
})

export function LlmStatsView(props: { scope: SessionScope; visible: boolean }): React.ReactNode {
  const { scope, visible } = props
  const [calls, setCalls] = useState<LlmCallStat[] | null>(null)
  const [totals, setTotals] = useState<LlmTotals | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Destructured BEFORE the callback: TabContent rebuilds its `scope`
  // OBJECT on every parent render, so keying the callback on the object
  // would recreate `refresh` each time and tear down the poll effect
  // (abort + immediate refetch + interval reset) on every one of them —
  // during a live request the shell re-renders often (session list
  // pushes), which turned the steady poll into a bursty abort/refetch
  // storm: the stopwatch never ticked and numbers landed in jumps. The
  // primitive fields are the real identity of the scope.
  const { sessionId, cwd } = scope
  const refresh = useCallback((signal?: AbortSignal) => {
    api.llmStats({ sessionId, cwd }, MAX_CALLS, signal)
      .then(result => {
        // Functional setState + identity-preserving merge: an unchanged
        // poll resolves to the previous references and React bails out
        // without rendering; a changed poll swaps ONLY the affected rows'
        // identities, so the memoized rows re-render one by one.
        const fresh = result.calls as LlmCallStat[]
        setCalls(prev => mergeCalls(prev, fresh))
        setTotals(prev => (totalsEqual(prev, result.totals) ? prev : result.totals))
        setError(null)
      })
      .catch((err: unknown) => {
        if (err instanceof SidebarApiError && err.code === 'abort') return
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [sessionId, cwd])

  // Whether any loaded call is still streaming — flips the poll cadence.
  const streaming = calls?.some(c => c.status === 'streaming') === true

  // Fresh-row detection: the FIRST window paints as a whole (no animation);
  // a row whose key first appears on a LATER commit slides in — the visual
  // cue that ONE new call arrived, instead of the table looking rebuilt.
  // Keyed on list identity (idempotent under StrictMode double-render: the
  // second pass sees every key already recorded and yields an empty set).
  const seenKeysRef = useRef<Set<string> | null>(null)
  const freshKeys = useMemo(() => {
    const seen = seenKeysRef.current
    if (seen === null) {
      // Still loading (calls === null): leave the ref null so the FIRST
      // data commit — not the blank pre-paint — seeds the window.
      if (calls === null) return new Set<string>()
      seenKeysRef.current = new Set(calls.map(call => call.key))
      return new Set<string>()
    }
    const fresh = new Set<string>()
    for (const call of calls ?? []) {
      if (!seen.has(call.key)) { seen.add(call.key); fresh.add(call.key) }
    }
    return fresh
  }, [calls])

  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    refresh(controller.signal)
    // Adaptive cadence: while any call is STREAMING the host mirror updates
    // per event, so a fast poll (~250ms) makes the row feel event-driven —
    // the row appears the moment the request starts, TTFT lands with the
    // first chunk, and the live stopwatch ticks smoothly. Idle falls back
    // to a relaxed 700ms.
    const poll = window.setInterval(() => {
      // The wall clock only matters to streaming rows' stopwatches — skip
      // the tick (and the re-render it triggers) when nothing is in flight.
      if (streaming) setNow(Date.now())
      refresh(controller.signal)
    }, streaming ? POLL_FAST_MS : POLL_IDLE_MS)
    return () => {
      window.clearInterval(poll)
      controller.abort()
    }
  }, [visible, refresh, streaming])

  // A paused (hidden) tab still ticks its stopwatch on resume: refresh `now`
  // once when visibility flips back on.
  useEffect(() => { if (visible) setNow(Date.now()) }, [visible])

  // Summary strip inputs, memoized on list identity — the 250ms `now`
  // ticks (streaming) re-render the parent but skip this recomputation.
  // Declared BEFORE the early returns (hooks order must not depend on
  // loading/empty state); a null list short-circuits to the zero case.
  const summary = useMemo(() => {
    // Avg TTFT stays over the loaded window (recent latency is what matters).
    const finished = (calls ?? []).filter(c => c.ttftMs !== undefined)
    const avgTtft = finished.length > 0
      ? finished.reduce((sum, c) => sum + (c.ttftMs ?? 0), 0) / finished.length
      : undefined
    // Tokens + cache % come from the WHOLE-LOG totals — the exact window and
    // formula DSH's own status line uses (cacheRead ÷ billed input over the
    // whole durable log), so the two numbers agree instead of ours reading
    // like a recent-window optimism.
    const tot = totals ?? { calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
    const inTok = tot.inputTokens + tot.cacheReadTokens + tot.cacheWriteTokens
    const outTok = tot.outputTokens
    const cachePct = inTok > 0 ? Math.round(tot.cacheReadTokens / inTok * 1000) / 10 : undefined
    const latestModel = calls?.find(c => c.model !== undefined)?.model
    return { tot, inTok, outTok, cachePct, avgTtft, latestModel }
  }, [calls, totals])
  const { tot, inTok, outTok, cachePct, avgTtft, latestModel } = summary

  if (error !== null) {
    return (
      <div className={css.llm}>
        <div className={css.llmEmpty}>{t('llmError')}: {error}</div>
      </div>
    )
  }
  if (calls === null) {
    return (
      <div className={css.llm}>
        <div className={css.llmEmpty}>{t('loading')}</div>
      </div>
    )
  }
  if (calls.length === 0) {
    return (
      <div className={css.llm}>
        <div className={css.llmEmpty}>{t('llmEmpty')}</div>
      </div>
    )
  }

  return (
    <div className={css.llm}>
      <div className={css.llmSummary}>
        {latestModel !== undefined && <span className={css.llmSummaryModel}>{latestModel}</span>}
        <span className={css.llmSummaryStat}>{t('llmCalls')} {tot.calls}</span>
        <span className={css.llmSummaryStat}>↑{fmtTok(inTok)} ↓{fmtTok(outTok)}</span>
        <span className={css.llmSummaryStat}>{t('llmAvgTtft')} {fmtMs(avgTtft)}</span>
        {cachePct !== undefined && (
          <span className={css.llmSummaryStat}>{t('llmCacheHit')} {cachePct}%</span>
        )}
      </div>
      <div className={css.llmTableWrap}>
        <table className={css.llmTable}>
          <thead>
            <tr>
              <th className={css.llmThLeft} scope="col">#</th>
              <th className={css.llmTh} scope="col">{t('llmAgoHeader')}</th>
              <th className={css.llmTh} scope="col">TTFT</th>
              <th className={css.llmTh} scope="col">{t('llmDuration')}</th>
              <th className={css.llmTh} scope="col">tok/s</th>
              <th className={css.llmTh} scope="col">{t('llmInput')}</th>
              <th className={css.llmTh} scope="col">{t('llmOutput')}</th>
              <th className={css.llmTh} scope="col">{t('llmCacheHit')}</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => (
              <LlmCallRow
                key={call.key}
                call={call}
                now={call.status === 'streaming' ? now : undefined}
                fresh={freshKeys.has(call.key)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
