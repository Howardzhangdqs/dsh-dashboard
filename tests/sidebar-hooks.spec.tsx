/**
 * Sidebar-tree hook-order regression: mounts the REAL Sidebar with the
 * session's full tab set (explorer + composer + llm-stats), drives the
 * async loads (icon set, llm stats), switches the active tab through every
 * pane occupant, and toggles panel visibility — any hook-count/order
 * violation (React #310 "Rendered more hooks than during the previous
 * render") throws HERE with the dev-mode component stack instead of a
 * minified production code.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Sidebar } from '../src/client/Sidebar.tsx'
import { activateTab, createSidebarStore, togglePanel } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { builtinTabs } from '../src/client/builtins/tabs.tsx'
import { registerDashboard } from '../src/client/dashboard.tsx'
import { LlmStatsView } from '../src/client/LlmStatsView.tsx'
import { IconPulseOutline16 } from '../src/client/icons.tsx'
import type { Context } from '../src/context-types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

// act() needs the React test-env flag; jsdom specs set it before mounting.
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** The packed icon member, pre-gunzipped (the route's browser-side form). */
const ICONS_JSON = gunzipSync(readFileSync(join(HERE, '..', 'assets', 'icons.json.gz'))).toString()

/** Cached snapshots (useSyncExternalStore compares references — a fresh
 *  object literal per call would loop the renderer). */
const LOCALE_SNAPSHOT = { active: 'zh' }
const SESSIONS_SNAPSHOT = { current: 's1', byId: { s1: { cwd: '/p' } } }

const realFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes('/sidebar/bundle/icons.json.gz')) {
      return new Response(ICONS_JSON, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/sidebar/api/llm.stats')) {
      return new Response(JSON.stringify({
        ok: true,
        value: {
          calls: [{ key: '1:1', turn: 1, step: 1, startedAt: Date.now(), ttftMs: 120, totalMs: 900, outputTokens: 40, status: 'done' }],
          totals: { calls: 1, inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 40 },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    // explorer fs.tree: real-ish entries so the tree renders file/dir rows
    // (the icon per-row path the real page exercises).
    if (url.includes('/sidebar/api/fs.tree')) {
      return new Response(JSON.stringify({
        ok: true,
        value: {
          path: '/p',
          entries: [
            { name: 'src', path: '/p/src', isDir: true, hidden: false },
            { name: 'package.json', path: '/p/package.json', isDir: false, hidden: false },
            { name: 'foo.ts', path: '/p/src/foo.ts', isDir: false, hidden: false },
            { name: 'logo.svg', path: '/p/logo.svg', isDir: false, hidden: false },
          ],
          truncated: false,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    // Editor fs.read: text content so the code viewer path resolves.
    if (url.includes('/sidebar/api/fs.read')) {
      return new Response(JSON.stringify({
        ok: true,
        value: { kind: 'text', content: 'export const x = 1\n', truncated: false },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    // git.diff: a minimal unified diff so DiffView's parser has real input.
    if (url.includes('/sidebar/api/git.diff')) {
      return new Response(JSON.stringify({
        ok: true,
        value: { diff: 'diff --git a/src/bar.ts b/src/bar.ts\n--- a/src/bar.ts\n+++ b/src/bar.ts\n@@ -1 +1 @@\n-old\n+new\n' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    // Everything else (git status, …): benign empty success.
    return new Response(JSON.stringify({ ok: true, value: { entries: [] } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

/** Minimal ctx double: the faces the Sidebar tree + registrations touch. */
function fakeCtx(service: unknown): Context {
  const noop = (): void => { }
  const off = (): (() => void) => () => { }
  const listeners: Array<() => void> = []
  const ctx = {
    locale: { subscribe: (cb: () => void) => { listeners.push(cb); return () => { } }, getSnapshot: () => LOCALE_SNAPSHOT },
    sessions: {
      list: {
        subscribe: off,
        getSnapshot: () => SESSIONS_SNAPSHOT,
      },
    },
    dashboard: service,
    slots: {
      inject: (_name: string, cb: () => (() => void) | undefined) => {
        const dispose = cb()
        return () => { dispose?.() }
      },
      register: () => () => { },
    },
    get: () => undefined,
    effect: (fn: () => (() => void) | undefined) => {
      const dispose = fn()
      return () => { dispose?.() }
    },
    on: () => () => { },
  }
  void noop
  return ctx as unknown as Context
}

describe('Sidebar tree hook order (React #310 regression)', () => {
  it('survives icon-set arrival, tab switches, and panel toggles', async () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const ctx = fakeCtx(service)
    for (const descriptor of builtinTabs(ctx)) service.registerTab(descriptor)
    // The llm-stats registration, exactly as src/client/index.tsx mounts it.
    service.registerTab({
      id: 'llm-stats',
      title: () => 'Stats',
      icon: (size: number) => createElement(IconPulseOutline16, { size }),
      order: 35,
      single: true,
      component: ({ scope, visible }) =>
        createElement(LlmStatsView, { scope, visible: visible === true }),
    })
    // The composer tab registration, exactly as registerDashboard mounts it.
    registerDashboard(ctx, service, store)

    // REAL PAGE ORDER: the tree mounts BEFORE any session is set (the
    // store's first snapshot has no session → Sidebar's no-session early
    // return), and the setSession effect lands AFTER mount — the re-render
    // must not change the hook count (React #310 regression).
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    await act(async () => { root.render(createElement(Sidebar, { ctx, store }) as ReactNode) })
    // Now the session arrives (mount effect order): the pane seeds below
    // re-render the full tree through the early-return boundary.
    act(() => {
      store.setSession('s1')
      store.update(s => {
        s.panelOpen = true
        s.splits = {
          kind: 'leaf',
          id: 'pane:1',
          tabs: [
            { id: 't1', type: 'explorer', title: 'Explorer' },
            { id: 't2', type: 'composer', title: 'Composer' },
            { id: 't3', type: 'llm-stats', title: 'Stats' },
            { id: 't4', type: 'editor', title: 'foo.ts', path: '/p/src/foo.ts' },
            { id: 't5', type: 'diff', title: 'bar.ts', path: '/p/src/bar.ts', diff: { kind: 'worktree', path: '/p/src/bar.ts', staged: false } },
          ],
          active: 't1',
        }
      })
    })
    // Flush the icon-set / stats resolutions (async microtasks).
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 10) }) })

    // Switch the pane's active tab through every occupant and back.
    for (const tabId of ['t2', 't3', 't4', 't5', 't1', 't3', 't4', 't2', 't1']) {
      act(() => { store.reduce(s => activateTab(s, 'pane:1', tabId)) })
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 5) }) })
    }

    // Panel visibility flips (visible=false pauses live views).
    act(() => { store.reduce(togglePanel) })
    act(() => { store.reduce(togglePanel) })
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 5) }) })

    // The tree must have rendered real content, not fallen into a boundary.
    expect(container.innerHTML.length).toBeGreaterThan(100)

    act(() => { root.unmount() })
    container.remove()
  })
})
