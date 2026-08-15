/**
 * Dashboard mode: turns the DSH left shell sidebar into an overlay drawer.
 *
 * - A footer cluster (Dashboard + composer-dock toggles wrapped in one
 *   element) is added above the Settings button via the `sidebar.footer.action`
 *   slot: wide renders the two labeled buttons side by side; the collapsed
 *   56px rail stacks them vertically as icon-only squares (DSH's own foot
 *   container is a flex row sized for a single action, so the pair must be
 *   wrapped to reflow without overflowing the rail).
 * - When Dashboard is ON, the AppFrame sidebar column is lifted out of the
 *   grid (`position: fixed`), the first grid track is zeroed so the
 *   conversation reclaims the full width, and the sidebar slides in/out as an
 *   overlay drawer.
 * - A page-corner DeepSeek trigger (registered in `shell.overlay`) stays
 *   fixed at the viewport's bottom-left — flush, with only the
 *   interior-facing corner rounded; hover or click expands the drawer, and
 *   mouse-leaving the sidebar closes it. While the drawer is open the
 *   trigger fades out of the way (the drawer owns that corner), so the
 *   drawer keeps its normal geometry with no reserved strip.
 * - The composer (input bar) is registered as a sidebar TAB — a peer of
 *   explorer/git/terminal in the + menu and the panel's tab strip, so panel
 *   width/resize/split dragging applies to it like any other page. While the
 *   tab is visible the seat is PROJECTED onto the tab host's rect via CSS
 *   (position:fixed + rAF-synced vars — its DOM never moves, keeping DSH's
 *   React tree and theming intact); hiding or closing the tab returns it to
 *   the center conversation.
 *
 * DOM anchoring uses only stable DSH attributes (never css-module hashes):
 * `data-shell-overlay` → its parent is the AppFrame grid; the frame's first
 * element child is the sidebar column. The sidebar's own collapse toggle is
 * hidden while Dashboard is on (located by its stable aria-label) so the two
 * mechanisms cannot fight.
 */
import { createElement, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Context } from '../context-types.ts'
import type { BetterSidebarService } from './service.ts'
import type { SidebarStore } from './state.ts'
import { allLeaves } from './state.ts'
import './dashboard.css'
import { LOGO_SVG } from './logo.ts'

// ── reactive module state (single source of truth, fiber-scoped) ────────────
let dashboardOn = false
let drawerOpen = false
/** Whether the conversation composer is currently hosted in a sidebar tab. */
let composerInTab = false
/** Store reference for tracking open composer tabs (set on registration). */
let composerStore: SidebarStore | null = null
const subscribers = new Set<() => void>()

function emit(): void {
  for (const fn of subscribers) fn()
}

/** Recompute `composerInTab` from the sidebar store (called on every store
 *  mutation) so the foot toggle's lit state tracks the composer tab's real
 *  open/close lifecycle — including the user closing the tab's own ×. */
function syncComposerInTab(): void {
  const state = composerStore?.getSnapshot().state
  const open = state !== undefined
    && allLeaves(state.splits).some(leaf => leaf.tabs.some(tab => tab.type === 'composer'))
  if (open !== composerInTab) {
    composerInTab = open
    emit()
  }
}

/** Find the open composer tab (wherever it lives in the split tree). */
function findComposerTab(): { id: string } | undefined {
  const state = composerStore?.getSnapshot().state
  return state === undefined
    ? undefined
    : allLeaves(state.splits).flatMap(leaf => leaf.tabs).find(t => t.type === 'composer')
}

/** Subscribe a component to dashboard state changes. */
function useDashboardState(): { on: boolean; open: boolean; docked: boolean } {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = (): void => bump((n) => n + 1)
    subscribers.add(fn)
    return () => { subscribers.delete(fn) }
  }, [])
  return { on: dashboardOn, open: drawerOpen, docked: composerInTab }
}

// ── DOM anchoring (stable attributes only) ──────────────────────────────────
function frameEl(): HTMLElement | null {
  const overlay = document.querySelector('[data-shell-overlay]')
  return (overlay?.parentElement as HTMLElement) ?? null
}

function sidebarColEl(frame: HTMLElement): HTMLElement | null {
  // The sidebar column is the AppFrame grid's first child.
  return (frame.firstElementChild as HTMLElement) ?? null
}

/** Mirror the frame's current details-column width into a CSS var so the
 *  overridden grid-template-columns can preserve it verbatim. */
function syncDetailsVar(frame: HTMLElement): void {
  const raw = getComputedStyle(frame).gridTemplateColumns
  const parts = raw.split(/\s+/).filter(Boolean)
  if (parts.length >= 3) frame.style.setProperty('--dsh-dash-details', parts[2] ?? '0px')
}

// ── registration ────────────────────────────────────────────────────────────
export function registerDashboard(
  ctx: Context,
  service: BetterSidebarService,
  store: SidebarStore,
): () => void {
  const layout = ctx.get('layout') as { toggleSidebar(): void } | undefined
  let ro: ResizeObserver | undefined
  let mo: MutationObserver | undefined
  let retryTimer: ReturnType<typeof setInterval> | undefined
  let leaveTimer: ReturnType<typeof setTimeout> | undefined
  let markedCol: HTMLElement | null = null
  let markedCenter: HTMLElement | null = null
  let markedDetails: HTMLElement | null = null

  const closeDrawer = (): void => {
    if (!drawerOpen) return
    drawerOpen = false
    document.documentElement.dataset.dshDrawer = 'closed'
    emit()
  }
  const onColLeave = (): void => {
    // small grace period so crossing the edge toward a portalled menu or the
    // conversation does not snap the drawer shut mid-interaction
    if (leaveTimer) clearTimeout(leaveTimer)
    leaveTimer = setTimeout(closeDrawer, 140)
  }
  const onColEnter = (): void => {
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = undefined }
  }

  const unmark = (): void => {
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = undefined }
    if (ro) { ro.disconnect(); ro = undefined }
    if (mo) { mo.disconnect(); mo = undefined }
    if (markedCol) {
      markedCol.removeEventListener('mouseleave', onColLeave)
      markedCol.removeEventListener('mouseenter', onColEnter)
    }
    const f = frameEl()
    if (f) { delete f.dataset.dshFrame; f.style.removeProperty('--dsh-dash-details') }
    if (markedCenter) { delete markedCenter.dataset.dshCenterCol; markedCenter = null }
    if (markedDetails) { delete markedDetails.dataset.dshDetailsCol; markedDetails = null }
    if (markedCol) { delete markedCol.dataset.dshSidebarCol; markedCol = null }
  }

  /** Tag the frame + sidebar column and start the details-width sync. */
  const mark = (): boolean => {
    const frame = frameEl()
    const col = frame && sidebarColEl(frame)
    if (!frame || !col) return false
    frame.dataset.dshFrame = ''
    col.dataset.dshSidebarCol = ''
    markedCol = col
    // Pin the center/details columns to tracks 2/3 so they do not reflow into
    // the zeroed first track once the sidebar column is lifted out of the grid.
    markedCenter = frame.children[1] as HTMLElement
    markedDetails = frame.children[2] as HTMLElement
    if (markedCenter) markedCenter.dataset.dshCenterCol = ''
    if (markedDetails) markedDetails.dataset.dshDetailsCol = ''
    syncDetailsVar(frame)
    col.addEventListener('mouseleave', onColLeave)
    col.addEventListener('mouseenter', onColEnter)
    ro = new ResizeObserver(() => syncDetailsVar(frame)); ro.observe(frame)
    mo = new MutationObserver(() => syncDetailsVar(frame))
    mo.observe(frame, { attributes: true, attributeFilter: ['style'] })
    return true
  }

  const enter = (): void => {
    // Ensure the sidebar renders WIDE (the session list). If it is currently
    // collapsed (data-sidebar-collapsed on the frame), toggle it open once.
    const frame = frameEl()
    if (frame && frame.hasAttribute('data-sidebar-collapsed') && layout) {
      layout.toggleSidebar()
    }
    dashboardOn = true
    drawerOpen = false
    document.documentElement.dataset.dshDashboard = 'on'
    document.documentElement.dataset.dshDrawer = 'closed'
    emit()
    if (!mark()) {
      // The toggle above re-renders the frame asynchronously; retry briefly.
      let tries = 0
      retryTimer = setInterval(() => {
        if (mark() || ++tries > 30) {
          if (retryTimer) { clearInterval(retryTimer); retryTimer = undefined }
        }
      }, 100)
    }
  }

  const exit = (): void => {
    if (retryTimer) { clearInterval(retryTimer); retryTimer = undefined }
    dashboardOn = false
    drawerOpen = false
    document.documentElement.dataset.dshDashboard = 'off'
    document.documentElement.dataset.dshDrawer = 'closed'
    emit()
    unmark()
  }

  const openDrawer = (): void => {
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = undefined }
    if (drawerOpen) return
    drawerOpen = true
    document.documentElement.dataset.dshDrawer = 'open'
    emit()
  }

  const offs: Array<() => void> = []
  // Open the composer sidebar tab (single: re-open focuses the existing tab).
  const openComposerTab = (): void => { service.openTab({ type: 'composer' }) }
  // Close it wherever it lives (split panes included).
  const closeComposerTab = (): void => {
    const tab = findComposerTab()
    if (tab) service.closeTab(tab.id)
  }
  // 1) Sidebar foot cluster: ONE `sidebar.footer.action` entry owning both
  //    toggles (Dashboard drawer mode + composer tab). Wrapping the pair is
  //    what lets it reflow — DSH renders foot actions in a flex row sized for
  //    a single entry, so two sibling registrations would sit side by side and
  //    overflow the collapsed 56px rail. The wrapper stacks them vertically
  //    when `wide` is false; see `.dsh-dash-foot` in dashboard.css.
  offs.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'dashboard-foot', order: -100, label: 'Dashboard / 输入框' },
    (props: { wide?: boolean }) => {
      const wide = props.wide !== false
      return createElement('div', { className: 'dsh-dash-foot' + (wide ? ' is-wide' : '') },
        createElement(DashboardToggle, {
          wide,
          onToggle: () => { dashboardOn ? exit() : enter() },
        }),
        createElement(ComposerDockToggle, {
          wide,
          onToggle: () => { composerInTab ? closeComposerTab() : openComposerTab() },
        }),
      )
    },
  )))

  // 2) The corner trigger: a page-corner DeepSeek glyph fixed at the
  //    viewport's bottom-left (flush, one rounded interior corner). It never
  //    rides the drawer: hover/click expands it, mouse-leaving the sidebar
  //    closes it, and while the drawer is open the trigger fades out of the
  //    way (dashboard.css) so the drawer owns the corner with no reserved
  //    strip and no content shift.
  offs.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'dashboard-trigger', order: -100 },
    () => createElement(DrawerTrigger, { onOpen: openDrawer }),
  )))

  // 3) The composer (input bar) as a sidebar TAB — a peer of explorer/git in
  //    the + menu and the panel's tab strip. While the tab is visible the
  //    DSH composer seat's DOM is adopted into the tab's host (so panel
  //    width/resize/drag comes for free); hiding or closing the tab returns
  //    the seat to its original center position. The foot toggle and the +
  //    menu both go through service.openTab (single: dedupes to focus).
  offs.push(service.registerTab({
    id: 'composer',
    title: () => '输入框',
    icon: (size: number) => ComposerDockIcon({ size }),
    order: 45,
    single: true,
    component: ({ visible }) => createElement(ComposerTab, { visible: visible === true }),
  }))

  // Track the composer tab's open/close lifecycle (including the tab's own
  // × button) so the foot toggle's lit state stays truthful.
  composerStore = store
  offs.push(store.subscribe(syncComposerInTab))
  syncComposerInTab()

  return () => {
    for (const off of offs) off()
    composerStore = null
    unmark()
  }
}

// ── components ──────────────────────────────────────────────────────────────
function DashboardToggle(props: { wide: boolean; onToggle: () => void }): ReactNode {
  const { on } = useDashboardState()
  return createElement('button', {
    type: 'button',
    className: 'dsh-dash-toggle' + (on ? ' is-on' : ''),
    'aria-pressed': on,
    'aria-label': 'Dashboard',
    title: on ? '退出 Dashboard 模式' : '进入 Dashboard 模式',
    onClick: props.onToggle,
  },
    createElement(DeepSeekGlyph, { size: props.wide ? 15 : 18 }),
    props.wide && createElement('span', { className: 'dsh-dash-label' }, 'Dashboard'),
  )
}

function DrawerTrigger(props: { onOpen: () => void }): ReactNode {
  const { on } = useDashboardState()
  if (!on) return null
  return createElement('button', {
    type: 'button',
    className: 'dsh-dash-trigger',
    'aria-label': '展开侧边栏',
    title: '展开',
    onMouseEnter: props.onOpen,
    onClick: props.onOpen,
  }, createElement(DeepSeekGlyph, { size: 22 }))
}

/** DeepSeek logo glyph (inlined from assets/dashboard-logo.svg); fill follows currentColor. */
function DeepSeekGlyph(props: { size: number }): ReactNode {
  return createElement('span', {
    className: 'dsh-dash-glyph',
    style: { width: props.size, height: props.size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
    'aria-hidden': true,
    dangerouslySetInnerHTML: { __html: LOGO_SVG },
  })
}

/** Composer tab toggle at the sidebar foot: opens/closes the composer tab. */
function ComposerDockToggle(props: { wide: boolean; onToggle: () => void }): ReactNode {
  const { docked } = useDashboardState()
  return createElement('button', {
    type: 'button',
    className: 'dsh-dash-toggle' + (docked ? ' is-on' : ''),
    'aria-pressed': docked,
    'aria-label': '输入框窗口',
    title: docked ? '关闭输入框侧栏窗口' : '输入框移到侧栏窗口',
    onClick: props.onToggle,
  },
    createElement(ComposerDockIcon, { size: props.wide ? 15 : 18 }),
    props.wide && createElement('span', { className: 'dsh-dash-label' }, '输入框'),
  )
}

/** Input bar glyph with a right-edge dock strip. */
function ComposerDockIcon(props: { size: number }): ReactNode {
  return createElement('svg', {
    width: props.size, height: props.size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
  },
    createElement('rect', { x: 2.5, y: 8, width: 13, height: 8, rx: 2, stroke: 'currentColor', strokeWidth: 1.6 }),
    createElement('rect', { x: 17, y: 5.5, width: 4.5, height: 13, rx: 1.2, fill: 'currentColor' }),
  )
}

/** The composer tab's body: a placeholder host whose viewport rect the real
 *  DSH composer seat is PROJECTED onto — the seat's DOM never moves out of
 *  its center-column React tree (adopting it there breaks DSH's commits:
 *  remounts unmount the seat from a parent it left, blanking the panel).
 *  Instead, while the tab is visible the seat is styled position:fixed
 *  centered on the host's rect (dashboard.css, driven by
 *  --dsh-composer-tab-* vars: top at the host's vertical center, width
 *  spanning the host), and a rAF loop keeps those vars in sync so panel
 *  drag-resize/reposition is followed live. Theming is untouched — the seat
 *  inherits the exact variables it had in the center, so its text/surfaces
 *  render correctly. Hiding/closing the tab just clears the flag; the seat
 *  snaps back to its normal center flow because it never left it. */
function ComposerTab(props: { visible: boolean }): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !props.visible) return

    document.documentElement.dataset.dshComposerTab = 'on'
    const rootStyle = document.documentElement.style
    const INSET = 8
    let raf = 0
    let last = ''
    const sync = (): void => {
      const r = host.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        // Horizontal: full host width (minus insets) — centered by span.
        // Vertical: the host's midpoint; translateY(-50%) in CSS centers the
        // seat on it regardless of the card's current height.
        const left = Math.round(r.left + INSET)
        const cy = Math.round(r.top + r.height / 2)
        const width = Math.round(r.width - INSET * 2)
        const key = `${left}:${cy}:${width}`
        if (key !== last) {
          last = key
          rootStyle.setProperty('--dsh-composer-tab-left', `${left}px`)
          rootStyle.setProperty('--dsh-composer-tab-cy', `${cy}px`)
          rootStyle.setProperty('--dsh-composer-tab-w', `${width}px`)
        }
      }
      raf = requestAnimationFrame(sync)
    }
    raf = requestAnimationFrame(sync)

    return () => {
      cancelAnimationFrame(raf)
      delete document.documentElement.dataset.dshComposerTab
    }
  }, [props.visible])

  return createElement('div', { ref: hostRef, className: 'dsh-composer-tabhost' })
}
