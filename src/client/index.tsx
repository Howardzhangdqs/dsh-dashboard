/**
 * Client half of dsh-dashboard: resolves the user's "Side card"
 * preferences through the plugin's own fenced settings route, mounts the
 * right sidebar portal (inside an error boundary so a rendering failure
 * shows an error strip instead of a blank panel), registers the turn-tail
 * interception, and contributes the Side card settings section to the DSH
 * Settings shell. Requires the runtime's slots and sessions services; the
 * bundle itself is a module-table consumer only (react + ui-primitives +
 * xterm, all provided or inlined).
 */
import { Component, createElement, type ErrorInfo, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context } from '../context-types.ts'
import { createSidebarStore } from './state.ts'
import { createBetterSidebarService } from './service.ts'
import { resetChunks } from './chunk-loader.ts'
import { registerBuiltins } from './builtins/index.ts'
import { Sidebar, SessionHeaderToggles } from './Sidebar.tsx'
import { ComposerCollapseToggle, initComposerCollapse } from './composer-collapse.tsx'
import { registerOpenPathInterception, registerTurnTailInterception } from './intercept.tsx'
import { registerImeGuard } from './ime-guard.ts'
import { loadPrefs } from './prefs.ts'
import { SideCardSection } from './SideCardSection.tsx'
import { LlmStatsView } from './LlmStatsView.tsx'
import { IconPulseOutline16 } from './icons.tsx'
import { api } from './api.ts'
import { LOCALE_NS, attachLocale, t, zh, en } from './locales.ts'
import css from './sidebar.module.css'
import './layout.css'
import { registerDashboard } from './dashboard.tsx'

/** Services required before mounting (provided by the client runtime; the
 *  locale service backs the sidebar's copy — see locales.ts). */
export const inject = ['slots', 'sessions', 'connection', 'workspaces', 'locale']

/**
 * Error boundary over the sidebar tree: a render error must never blank the
 * whole panel silently — it shows a dismissible error strip and logs the
 * stack for diagnosis. The strip also carries the component lineage
 * (componentStack survives minification: it names the crashing component
 * even for opaque codes like React #310).
 */
class SidebarBoundary extends Component<{ children: ReactNode }, { error: string | null; stack: string | null }> {
  state = { error: null as string | null, stack: null as string | null }

  static getDerivedStateFromError(error: unknown): { error: string; stack: null } {
    return { error: error instanceof Error ? error.message : String(error), stack: null }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[dsh-dashboard] render error:', error, info.componentStack)
    const lines = (info.componentStack ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .slice(0, 6)
      .join(' ← ')
    this.setState({ stack: lines.length > 0 ? lines : null })
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className={css.boundaryError}>
          <span>dsh-dashboard: {this.state.error}</span>
          {this.state.stack !== null && (
            <span style={{ display: 'block', opacity: 0.7, marginTop: 4, wordBreak: 'break-all' }}>
              {this.state.stack}
            </span>
          )}
          <button
            type="button"
            className={css.terminalRetry}
            onClick={() => { this.setState({ error: null, stack: null }) }}
          >
            {t('terminalRetry')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots, sessions).
 */
export function apply(ctx: Context): void {
  // The sidebar follows the DSH i18n system: attach the locale service so
  // the module-level t()/isZh() resolve the Host-backed language preference
  // (and switch live — the Sidebar root subscribes to it), and register the
  // plugin's dictionaries into the shared locale registry. The disposers
  // run on fiber disposal, so re-activation (HMR) re-registers cleanly.
  attachLocale(ctx.locale)
  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
    const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
    return () => { offZh(); offEn() }
  }, 'dsh-dashboard: dictionaries')
  // One store instance per activation: production code creates it only here,
  // then hands it to the mounted panel and closes over it in the slot
  // registrations (the official createXXXStore() factory rule — no
  // module-level singleton).
  const sidebarStore = createSidebarStore()
  // The sidebar registry service: external plugins register tab types and
  // file previewers through `ctx.dashboard.registerTab/registerFileViewer`.
  // Published before the panel mounts so consumers injecting 'dashboard'
  // (or the legacy 'betterSidebar' alias) are ready by the time the sidebar
  // renders.
  const service = createBetterSidebarService(sidebarStore)
  // Published under the package's own name; the legacy `betterSidebar` id is
  // re-provided as a compatibility alias so external plugins injecting the
  // pre-rename service id keep resolving the same instance.
  ctx.provide('dashboard', service)
  ctx.provide('betterSidebar', service)
  // Register the plugin's own built-in tabs and viewers through the same
  // service (eating our own dogfood). The disposer unregisters them on
  // fiber disposal (HMR-safe).
  ctx.effect(
    () => registerBuiltins(ctx, service),
    'dsh-dashboard: register built-in tabs and viewers',
  )
  // A failure anywhere in the client lifecycle must never take the app down
  // silently: log with the plugin prefix and pin a visible diagnostic strip
  // to the page so a blank panel is never the only symptom.
  const fail = (phase: string, error: unknown): void => {
    console.error(`[dsh-dashboard] ${phase} error:`, error)
    try {
      const bar = document.createElement('div')
      bar.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;'
        + 'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f2a1a1;background:#1b1b22;'
        + 'border:1px solid #f2a1a1;border-radius:8px;white-space:pre-wrap'
      bar.textContent = `[dsh-dashboard] ${phase} error: ${error instanceof Error ? error.message : String(error)}`
      document.body.appendChild(bar)
    } catch {
      // Nothing left to report with.
    }
  }
  try {
    // Fresh chunk state for this activation: invalidate any chunk factories
    // registered by a previous fiber (HMR) and drop the in-memory load cache
    // so the next lazy open re-fetches the current chunk scripts.
    resetChunks()
    ctx.effect(() => {
      let disposed = false
      let root: Root | undefined
      let host: HTMLDivElement | undefined
      void (async () => {
        // Resolve the user's side card prefs BEFORE the first session seeds,
        // so a brand-new conversation opens (or stays closed) at the chosen
        // width from first paint. A settings route failure falls back to the
        // schema defaults; the sidebar still mounts (a stalled wire gives up
        // after the timeout and mounts on the defaults).
        const prefs = await Promise.race([
          loadPrefs(api),
          new Promise<null>(resolve => { const timer = window.setTimeout(() => resolve(null), 2000) }),
        ])
        if (prefs !== null) sidebarStore.setPrefs(prefs)
        if (disposed) return
        try {
          host = document.createElement('div')
          host.setAttribute('data-dsh-dashboard', '')
          document.body.appendChild(host)
          root = createRoot(host)
          root.render(createElement(SidebarBoundary, null, createElement(Sidebar, { ctx, store: sidebarStore })))
        } catch (error) {
          fail('mount', error)
        }
      })()
      return () => {
        disposed = true
        root?.unmount()
        host?.remove()
      }
    }, 'dsh-dashboard: sidebar mount')

    ctx.effect(
      () => {
        try {
          return registerTurnTailInterception(ctx, sidebarStore)
        } catch (error) {
          fail('interception', error)
          return undefined
        }
      },
      'dsh-dashboard: turn-tail interception',
    )

    ctx.effect(
      () => {
        try {
          return registerOpenPathInterception(ctx, sidebarStore)
        } catch (error) {
          fail('interception', error)
          return undefined
        }
      },
      'dsh-dashboard: open-path interception',
    )

    // The IME guard: composition keys (candidate arrows, confirm, cancel)
    // belong to the input method, never to page JS. Inlined third-party UI
    // (Univer's office controls) has shipped unguarded keydown handlers that
    // hijack ArrowUp/ArrowDown and break Chinese input (#562 regression); the
    // document-capture guard neutralizes the whole class before React or any
    // native listener sees the event. Registered as early as possible so no
    // other capture-phase listener can win the ordering race.
    ctx.effect(
      () => {
        try {
          return registerImeGuard()
        } catch (error) {
          fail('ime guard', error)
          return undefined
        }
      },
      'dsh-dashboard: IME composition guard',
    )

    // The "Side card" settings section: appears in the DSH Settings shell
    // once the shell's declaration is on the ledger (slots.inject waits for
    // it); the section reads/writes the prefs through the plugin's own
    // fenced settings route, keeps the shared store in sync, and renders the
    // declarative enable/disable inventory from the tab/viewer registry.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'dashboard-settings',
      order: 100,
      label: () => t('settingsNav'),
      inject: () => ({ store: sidebarStore, service }),
    }, SideCardSection))

    // The two panel toggles INSIDE the session header: registered into the
    // header's utilities slot after the "Session log" download capsule
    // (order 100 vs the capsule's default 0 — the slot sorts ascending), so
    // the buttons sit in-flow right of it instead of overlaying the
    // viewport corner. The header squeezes with the center column while the
    // right panel is open, keeping the toggles reachable in every state.
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'dashboard-panel-toggles',
      order: 100,
    }, () => createElement(SessionHeaderToggles, { store: sidebarStore })))

    // The composer collapse toggle: registered into the input tool row's
    // right-end list slot (`conversation.input.right` — the seat DSH docs
    // as "a control the user reaches on the way to sending"), which renders
    // immediately LEFT of the model seat. Expanded, the 28px button folds
    // the input card into one full-width line (pure CSS keyed on the body
    // attribute, see layout.css); collapsed, the same button expands it.
    // The preference persists across reloads (localStorage) and applies on
    // activation so a stored fold paints collapsed from first render.
    initComposerCollapse()
    ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
      name: 'conversation.input.right',
      id: 'dashboard-composer-collapse',
      order: 100,
    }, () => createElement(ComposerCollapseToggle)))

    // The LLM stats tab: the session's recent model API requests (tokens,
    // cache hits, TTFT, duration, tok/s) served by the host's 'llm.stats'
    // route. Registered separately from the 7 built-ins — it is a metrics
    // page, not a workspace surface, and the built-in contract stays at 7.
    ctx.effect(
      () => service.registerTab({
        id: 'llm-stats',
        title: () => t('llmStats'),
        icon: (size: number) => <IconPulseOutline16 size={size} />,
        order: 35,
        single: true,
        component: ({ scope, visible }) => (
          <LlmStatsView scope={scope} visible={visible === true} />
        ),
      }),
      'dsh-dashboard: llm stats tab',
    )

    // Dashboard drawer mode + composer sidebar tab: turns the DSH left
    // sidebar into an overlay drawer toggled from a button placed just above
    // Settings, and registers the conversation composer as a sidebar tab
    // (like explorer/git). Client-only; the returned disposer unregisters
    // the slots, tab, and DOM tags on fiber disposal.
    ctx.effect(
      () => registerDashboard(ctx, service, sidebarStore),
      'dsh-dashboard: dashboard drawer mode',
    )
  } catch (error) {
    fail('load', error)
  }
}
