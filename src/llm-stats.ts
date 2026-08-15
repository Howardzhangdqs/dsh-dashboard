/**
 * The 'llm.stats' route of the /sidebar JSON API: per-model-call metrics for
 * the LLM requests a session has made — input/output tokens, prompt-cache
 * hits, TTFT (time to first streamed chunk), total request duration, and
 * average output speed (tok/s over the total time, TTFT included).
 *
 * Source = the session's own event log, the same zero-write replay the jobs
 * routes use: `step/start` marks a call, the `assistant/chunk` stream gives
 * the first-chunk (TTFT) and last-chunk timestamps plus the `usage` chunk,
 * `assistant/message` finalizes usage and names provider/model, and
 * `step/end` bounds calls that never produced a message. Because the
 * session store's in-memory log can lag the live append feed after a host
 * restart, the route ALSO mirrors the relevant events from the live
 * `session/event` feed and merges both sources (deduped by turn:step).
 *
 * Token accounting mirrors dsh-llm's `TokenUsage`: `inputTokens` is UNCACHED
 * input only; cached input is reported separately as
 * `cacheReadTokens`/`cacheWriteTokens` (billed input = the sum of the
 * three). Providers whose adapters fold cache hits into a total report only
 * the totals — the cache fields are simply absent then.
 */
import type { Context, SidebarSessionEvent } from './context-types.ts'
import { requireString, SidebarError } from './wire.ts'

/** One model call's derived metrics (all times are epoch ms). */
export interface LlmCallStat {
  /** Stable call identity within the session: `turn:step`. */
  key: string
  turn: number
  step: number
  /** When the call started (step/start). */
  startedAt: number
  /** First streamed chunk → TTFT in ms (undefined before the first chunk). */
  ttftMs?: number
  /** Request duration in ms: start → last chunk (or message / step end). */
  totalMs?: number
  /** Generation phase in ms: first chunk → last chunk (diagnostic only). */
  genMs?: number
  /** Output tokens per second over the TOTAL request time (TTFT included). */
  tokPerSec?: number
  /** Uncached input tokens (billed input = input + cacheRead + cacheWrite). */
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Provider + model as reported by the finished message / request context. */
  provider?: string
  model?: string
  /** Context window from the session's request/context event, when seen. */
  contextWindow?: number
  /** Streaming (chunks seen, no message yet) vs finalized. */
  status: 'streaming' | 'done'
}

/** Whole-log token totals, the SAME window DSH's own status line uses
 *  ("cache-hit share of prompt-side input over the whole durable log"):
 *  cumulative over every call in the session, not the recent-calls window
 *  the table rows show. Cache % from these numbers matches the app's. */
export interface LlmStatsTotals {
  /** Total model calls in the whole log. */
  calls: number
  /** Uncached input tokens (billed = input + cacheRead + cacheWrite). */
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** The 'llm.stats' API face. */
export interface LlmStatsRoutes {
  /** The session's most recent model calls (newest first) + whole-log totals. */
  stats(payload: unknown): { calls: LlmCallStat[]; totals: LlmStatsTotals }
}

/** Numeric coercion helper: undefined for anything not a finite number. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The usage shape of a `usage` chunk / finished message (dsh-llm TokenUsage). */
interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Fold a raw usage object into a partial stat (last write wins per field). */
function mergeUsage(target: Partial<LlmCallStat>, raw: unknown): void {
  const usage = raw as UsageLike | undefined
  if (usage === null || typeof usage !== 'object') return
  const input = num(usage.inputTokens)
  const output = num(usage.outputTokens)
  const cacheRead = num(usage.cacheReadTokens)
  const cacheWrite = num(usage.cacheWriteTokens)
  if (input !== undefined) target.inputTokens = input
  if (output !== undefined) target.outputTokens = output
  if (cacheRead !== undefined) target.cacheReadTokens = cacheRead
  if (cacheWrite !== undefined) target.cacheWriteTokens = cacheWrite
}

/** Merge two sample sets of the same call (seed + live mirror): earliest
 *  start, first/last chunk extremes, and per-field usage (mirror wins). */
function mergeCall(target: CallSamples, incoming: CallSamples): CallSamples {
  target.startedAt = Math.min(target.startedAt, incoming.startedAt)
  if (target.firstChunkAt === undefined) target.firstChunkAt = incoming.firstChunkAt
  else if (incoming.firstChunkAt !== undefined) target.firstChunkAt = Math.min(target.firstChunkAt, incoming.firstChunkAt)
  if (target.lastChunkAt === undefined) target.lastChunkAt = incoming.lastChunkAt
  else if (incoming.lastChunkAt !== undefined) target.lastChunkAt = Math.max(target.lastChunkAt, incoming.lastChunkAt)
  if (target.messageAt === undefined) target.messageAt = incoming.messageAt
  if (target.stepEndAt === undefined) target.stepEndAt = incoming.stepEndAt
  for (const [field, value] of Object.entries(incoming.stat)) {
    if (value !== undefined) (target.stat as Record<string, unknown>)[field] = value
  }
  return target
}

/** Recompute the derived speed metric after tokens/timings change. The
 *  denominator is the TOTAL request time (start → last chunk, TTFT
 *  included): dividing by the bare generation phase yields absurd rates
 *  whenever chunk timestamps cluster (batched/replayed streams report
 *  everything at once, making genMs single-digit ms). */
function recompute(target: Partial<LlmCallStat>): void {
  if (target.outputTokens !== undefined && target.totalMs !== undefined && target.totalMs > 0) {
    target.tokPerSec = Math.round((target.outputTokens / target.totalMs) * 1000 * 10) / 10
  }
}

/**
 * Fold one raw session event into the per-call accumulator map. Keys are
 * `turn:step`; unknown event types are ignored. The map holds the RAW
 * samples (timestamps, usage parts); derivation to {@link LlmCallStat}
 * happens once at read time.
 */
interface CallSamples {
  key: string
  turn: number
  step: number
  startedAt: number
  firstChunkAt?: number
  lastChunkAt?: number
  messageAt?: number
  stepEndAt?: number
  stat: Partial<LlmCallStat>
}

function foldEvent(calls: Map<string, CallSamples>, event: SidebarSessionEvent): void {
  const data = event.data as Record<string, unknown>
  if (data === null || typeof data !== 'object') return
  const turn = num(data.turn)
  const step = num(data.step)
  // request/context is call-less: it names provider/model/contextWindow for
  // the whole session (folded into every call at derive time).
  if (event.type === 'request/context') {
    return // handled by the caller (session-level, not per call)
  }
  if (turn === undefined || step === undefined) return
  const key = `${turn}:${step}`
  let call = calls.get(key)
  if (call === undefined) {
    call = { key, turn, step, startedAt: event.time, stat: {} }
    calls.set(key, call)
    // A stream observed without its step/start begins at the first chunk —
    // the TTFT is then 0-ish rather than wrong-by-a-session.
  }
  switch (event.type) {
    case 'step/start':
      call.startedAt = event.time
      break
    case 'assistant/chunk': {
      if (call.firstChunkAt === undefined) call.firstChunkAt = event.time
      call.lastChunkAt = event.time
      const chunk = data.chunk as { type?: unknown; usage?: unknown } | undefined
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') {
        mergeUsage(call.stat, chunk.usage)
      }
      break
    }
    case 'assistant/message': {
      call.messageAt = event.time
      if (call.lastChunkAt === undefined) call.lastChunkAt = event.time
      mergeUsage(call.stat, data.usage)
      const source = (data.message as { source?: { provider?: unknown; model?: unknown } } | undefined)?.source
      if (source !== null && typeof source === 'object') {
        if (typeof source.provider === 'string') call.stat.provider = source.provider
        if (typeof source.model === 'string') call.stat.model = source.model
      }
      break
    }
    case 'step/end':
      call.stepEndAt = event.time
      break
    default:
      break
  }
}

/** Derive the wire stat from one call's raw samples. */
function derive(call: CallSamples, session: { provider?: string; model?: string; contextWindow?: number }): LlmCallStat {
  const stat: Partial<LlmCallStat> = { ...call.stat }
  stat.provider = stat.provider ?? session.provider
  stat.model = stat.model ?? session.model
  stat.contextWindow = session.contextWindow
  const totalEnd = call.lastChunkAt ?? call.messageAt ?? call.stepEndAt
  if (totalEnd !== undefined && totalEnd >= call.startedAt) {
    stat.totalMs = totalEnd - call.startedAt
  }
  if (call.firstChunkAt !== undefined && call.firstChunkAt >= call.startedAt) {
    stat.ttftMs = call.firstChunkAt - call.startedAt
  }
  if (call.firstChunkAt !== undefined && call.lastChunkAt !== undefined && call.lastChunkAt >= call.firstChunkAt) {
    stat.genMs = call.lastChunkAt - call.firstChunkAt
  }
  recompute(stat)
  return {
    key: call.key,
    turn: call.turn,
    step: call.step,
    startedAt: call.startedAt,
    status: call.messageAt === undefined && call.stepEndAt === undefined ? 'streaming' : 'done',
    ...stat,
  } as LlmCallStat
}

/** Per-session cap of mirrored live calls (a bounded, lossy ring). */
const MIRROR_MAX_CALLS = 120

/**
 * The live model-call mirror: subscribes to the session append feed and
 * keeps the calls the session store's own log can lag behind (the same
 * restart boundary the jobs mirror covers). Zero DSH writes: the api-proxy
 * pushes the same feed to browsers.
 */
function createLlmStatsMirror(ctx: Context): { calls(sessionId: string): Map<string, CallSamples> } {
  const perSession = new Map<string, Map<string, CallSamples>>()
  if (typeof ctx.on !== 'function') {
    // Test doubles without the event API degrade to seed-only replay.
    return { calls: () => new Map() }
  }
  const dispose = ctx.on('session/event', (session, event) => {
    const sessionId = (session as { id?: unknown } | null)?.id
    if (typeof sessionId !== 'string') return
    if (event.type !== 'step/start' && event.type !== 'assistant/chunk'
      && event.type !== 'assistant/message' && event.type !== 'step/end') return
    let calls = perSession.get(sessionId)
    if (calls === undefined) perSession.set(sessionId, calls = new Map())
    foldEvent(calls, event)
    if (calls.size > MIRROR_MAX_CALLS) {
      // Drop the OLDEST calls (smallest startedAt) — keep the recent tail.
      const ordered = [...calls.values()].sort((a, b) => a.startedAt - b.startedAt)
      for (const victim of ordered.slice(0, calls.size - MIRROR_MAX_CALLS)) calls.delete(victim.key)
    }
  })
  ctx.effect(() => dispose, 'dsh-dashboard: llm-stats event mirror')
  return { calls: (sessionId) => perSession.get(sessionId) ?? new Map() }
}

/**
 * Build the llm.stats route bound to the plugin context: merge the store's
 * event log (durable seed) with the live mirror, dedupe by turn:step, and
 * return the newest calls first.
 * @param ctx - host plugin context.
 */
export function buildLlmStatsApi(ctx: Context): LlmStatsRoutes {
  const mirror = createLlmStatsMirror(ctx)
  return {
    stats(payload) {
      const sessionId = requireString(payload, 'sessionId')
      const record = payload as { limit?: unknown } | null
      const limitRaw = num(record?.limit)
      const limit = limitRaw !== undefined && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 30
      // Session-level facts from request/context (provider/model/context
      // window) seed calls whose own message carried no source.
      let sessionInfo: { provider?: string; model?: string; contextWindow?: number } = {}
      for (const event of ctx.sessions.get(sessionId)?.events ?? []) {
        if (event.type === 'request/context') {
          const data = event.data as { provider?: unknown; model?: unknown; contextWindow?: unknown }
          sessionInfo = {
            provider: typeof data.provider === 'string' ? data.provider : undefined,
            model: typeof data.model === 'string' ? data.model : undefined,
            contextWindow: num(data.contextWindow),
          }
        }
      }
      // Merge the store seed with the live mirror per call key: field-level
      // merge, so a mirror entry that began mid-stream keeps the seed's
      // step/start timestamp (correct TTFT) and the seed keeps the mirror's
      // newer chunks/usage.
      const merged = new Map<string, CallSamples>()
      for (const event of ctx.sessions.get(sessionId)?.events ?? []) {
        if (event.type === 'step/start' || event.type === 'assistant/chunk'
          || event.type === 'assistant/message' || event.type === 'step/end') {
          foldEvent(merged, event)
        }
      }
      for (const [key, call] of mirror.calls(sessionId)) {
        const existing = merged.get(key)
        if (existing === undefined) merged.set(key, call)
        else mergeCall(existing, call)
      }
      // Whole-log token totals (DSH's own status window): summed over EVERY
      // call before the recent-calls slice, so the summary's cache % matches
      // the app's own display instead of a recent-window optimism.
      let inputTokens = 0
      let cacheReadTokens = 0
      let cacheWriteTokens = 0
      let outputTokens = 0
      for (const call of merged.values()) {
        inputTokens += call.stat.inputTokens ?? 0
        cacheReadTokens += call.stat.cacheReadTokens ?? 0
        cacheWriteTokens += call.stat.cacheWriteTokens ?? 0
        outputTokens += call.stat.outputTokens ?? 0
      }
      const totals: LlmStatsTotals = {
        calls: merged.size,
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        outputTokens,
      }
      const calls = [...merged.values()]
        .sort((left, right) => right.startedAt - left.startedAt)
        .slice(0, limit)
        .map((call) => derive(call, sessionInfo))
      if (ctx.sessions.get(sessionId) === undefined && calls.length === 0) {
        throw new SidebarError('not-found', `unknown session "${sessionId}"`, 404)
      }
      return { calls, totals }
    },
  }
}
