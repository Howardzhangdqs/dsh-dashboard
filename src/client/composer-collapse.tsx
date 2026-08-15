/**
 * Collapsed composer: a one-line input bar.
 *
 * A 28px toggle (registered into the composer tool row's right-end slot
 * `conversation.input.right`, see src/client/index.tsx — the slot renders
 * immediately LEFT of the model seat) folds the input card into a single
 * full-width row: [+ attach] [permission icon] [one-line input] [expand]
 * [model] [context ring] [send]. The fold itself is pure CSS driven by the
 * `<body data-dsh-composer-collapsed>` attribute (see layout.css — the tool
 * row is unwrapped with display:contents and the card becomes one flex
 * row); this module only owns the PREFERENCE: a module-level boolean
 * persisted to localStorage, mirrored onto the body attribute, and exposed
 * to React through useSyncExternalStore so every mounted toggle (and any
 * future consumer) agrees without prop-drilling. One activation applies
 * the persisted value once via {@link initComposerCollapse}.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { IconChevronDownOutline14, IconChevronUpOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** localStorage keys for the persisted fold state: the package's own id,
 *  with the pre-rename key consulted as a fallback so an existing fold
 *  survives the rename. */
const STORAGE_KEY = 'dsh-dashboard:composer-collapsed'
const LEGACY_STORAGE_KEY = 'dsh-better-sidebar:composer-collapsed'
/** Body attribute the collapsed-layout CSS keys on (see layout.css). */
const BODY_ATTR = 'data-dsh-composer-collapsed'

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
      || window.localStorage.getItem(LEGACY_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

// Fiber-scoped module state (same posture as dashboard.tsx): the boolean is
// the single source of truth; React subscribes through useSyncExternalStore.
let collapsed = readStored()
const listeners = new Set<() => void>()

/** Mirror the current state onto <body> — the CSS only reads the attribute. */
function applyBodyAttribute(): void {
  if (collapsed) document.body.setAttribute(BODY_ATTR, '')
  else document.body.removeAttribute(BODY_ATTR)
}

/** Current fold state (non-hook accessor). */
export function isComposerCollapsed(): boolean {
  return collapsed
}

/** Class on the card while its box-height FLIP runs (see layout.css). */
const FOLD_ANIM_CLASS = 'dsh-composer-fold-anim'
/** Safety timeout past the CSS duration (ms) in case transitionend never fires. */
const FOLD_SAFETY_MS = 520

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * FLIP the card's box height across the fold. The layout swap itself is not
 * animatable (flex-direction + display changes), so the CARD envelope is
 * height-animated instead: freeze the pre-flip height, apply the attribute
 * flip synchronously, measure the post-flip natural height, then transition
 * between the two — no paint happens between the steps, so the fold reads
 * as one continuous motion (children clip behind the card's border-radius
 * via overflow:hidden on the anim class). Re-entrant by construction: a
 * second toggle mid-flight measures the CURRENT interpolated height as its
 * `from`.
 */
function animateCardFold(flip: () => void): void {
  const card = document.querySelector('[data-composer-card]')
  if (!(card instanceof HTMLElement) || prefersReducedMotion()) {
    flip()
    return
  }
  const from = card.offsetHeight
  flip()
  const prevInline = card.style.height
  card.style.height = 'auto'
  const to = card.offsetHeight
  if (Math.abs(to - from) <= 1) {
    card.style.height = prevInline
    return
  }
  card.classList.add(FOLD_ANIM_CLASS)
  card.style.height = `${from}px`
  void card.offsetHeight // reflow: the transition must start from `from`
  card.style.height = `${to}px`
  let finished = false
  const done = (): void => {
    if (finished) return
    finished = true
    card.classList.remove(FOLD_ANIM_CLASS)
    card.style.height = ''
    card.removeEventListener('transitionend', onEnd)
    window.clearTimeout(timer)
  }
  const onEnd = (event: TransitionEvent): void => {
    if (event.target === card && event.propertyName === 'height') done()
  }
  const timer = window.setTimeout(done, FOLD_SAFETY_MS)
  card.addEventListener('transitionend', onEnd)
}

/** Set the fold state: animates the card envelope, persists, mirrors onto
 *  <body>, notifies subscribers. */
export function setComposerCollapsed(next: boolean): void {
  if (next === collapsed) return
  collapsed = next
  const flip = (): void => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
    } catch {
      // Private mode / storage disabled: the fold still works for the session.
    }
    applyBodyAttribute()
    for (const fn of listeners) fn()
  }
  animateCardFold(flip)
}

/** Apply the persisted state to <body> once per plugin activation. */
export function initComposerCollapse(): void {
  applyBodyAttribute()
}

/** Reactive fold state for React consumers. */
export function useComposerCollapsed(): boolean {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
    () => collapsed,
    () => collapsed,
  )
}

/**
 * The toggle button itself: a 28px ghost circle (the shared
 * `.toggleButton` chrome) wrapped in a top-side Tooltip. `mousedown` is
 * suppressed so clicking it never blurs the composer's textarea — the
 * same keep-focus posture as the bar's own buttons.
 */
export function ComposerCollapseToggle(): ReactNode {
  const collapsed = useComposerCollapsed()
  const label = collapsed ? t('expandComposer') : t('collapseComposer')
  return (
    <Tooltip label={label} side="top" delayMs={500}>
      <button
        type="button"
        className={css.toggleButton}
        aria-label={label}
        aria-pressed={collapsed}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { setComposerCollapsed(!collapsed) }}
      >
        {collapsed ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
      </button>
    </Tooltip>
  )
}
