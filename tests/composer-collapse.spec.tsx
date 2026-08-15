/**
 * Composer-collapse spec: the one-line input-bar fold. Covers the
 * preference store (persistence + the <body data-dsh-composer-collapsed>
 * mirror the CSS keys on), the activation-time application of a stored
 * fold, and the toggle button itself (renders into any container, flips
 * the body attribute + aria-pressed on click, and relabels between
 * collapse/expand).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  ComposerCollapseToggle,
  initComposerCollapse,
  isComposerCollapsed,
  setComposerCollapsed,
} from '../src/client/composer-collapse.tsx'

// act() needs the React test-env flag; jsdom specs set it before mounting.
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const STORAGE_KEY = 'dsh-dashboard:composer-collapsed'
const BODY_ATTR = 'data-dsh-composer-collapsed'

afterEach(() => {
  setComposerCollapsed(false)
  window.localStorage.clear()
  document.body.removeAttribute(BODY_ATTR)
  document.body.innerHTML = ''
})

describe('composer collapse (preference store)', () => {
  it('starts expanded and applies nothing to <body>', () => {
    expect(isComposerCollapsed()).toBe(false)
    initComposerCollapse()
    expect(document.body.hasAttribute(BODY_ATTR)).toBe(false)
  })

  it('folding mirrors the attribute, persists, and unfolds cleanly', () => {
    setComposerCollapsed(true)
    expect(document.body.hasAttribute(BODY_ATTR)).toBe(true)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1')
    expect(isComposerCollapsed()).toBe(true)

    setComposerCollapsed(false)
    expect(document.body.hasAttribute(BODY_ATTR)).toBe(false)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('0')
    expect(isComposerCollapsed()).toBe(false)
  })

  it('is a no-op to set the state it already has', () => {
    setComposerCollapsed(true)
    setComposerCollapsed(true)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1')
    expect(document.body.getAttribute(BODY_ATTR)).toBe('')
  })

  it('applies a persisted fold on activation (module read at import)', async () => {
    // Reset the module registry so the dynamic import re-evaluates the
    // module (and its import-time localStorage read) against the fold.
    window.localStorage.setItem(STORAGE_KEY, '1')
    vi.resetModules()
    const fresh = await import('../src/client/composer-collapse.tsx')
    expect(fresh.isComposerCollapsed()).toBe(true)
    fresh.initComposerCollapse()
    expect(document.body.hasAttribute(BODY_ATTR)).toBe(true)
    // Leave the shared <body> clean for the next test (the statically
    // imported instance used by the other tests still holds its own state).
    fresh.setComposerCollapsed(false)
    expect(document.body.hasAttribute(BODY_ATTR)).toBe(false)
  })
})

describe('composer collapse (toggle button)', () => {
  const mount = (): HTMLButtonElement => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let root: Root | undefined
    act(() => {
      root = createRoot(host)
      root.render(createElement(ComposerCollapseToggle))
    })
    const button = host.querySelector('button')
    if (button === null) throw new Error('toggle button not rendered')
    return button
  }

  it('renders a 28px-classed button labelled for collapsing while expanded', () => {
    setComposerCollapsed(false)
    const button = mount()
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('aria-label')).toBe('Collapse input bar')
    expect(button.querySelector('svg')).not.toBeNull()
  })

  it('clicking folds: body attribute + aria-pressed flip together', () => {
    setComposerCollapsed(false)
    const button = mount()
    act(() => { button.click() })
    expect(document.body.hasAttribute(BODY_ATTR)).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('aria-label')).toBe('Expand input bar')

    act(() => { button.click() })
    expect(document.body.hasAttribute(BODY_ATTR)).toBe(false)
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('FLIP-animates the card envelope when a card is present', () => {
    // A fake composer card whose measured height tracks the fold state
    // (jsdom lays nothing out, so offsetHeight is stubbed).
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    Object.defineProperty(card, 'offsetHeight', {
      configurable: true,
      get: () => (document.body.hasAttribute(BODY_ATTR) ? 40 : 100),
    })
    document.body.appendChild(card)

    setComposerCollapsed(true)
    // Frozen at the pre-flip height, transitioning toward the post-flip one.
    expect(card.classList.contains('dsh-composer-fold-anim')).toBe(true)
    expect(card.style.height).toBe('40px')

    // transitionend (height) releases the inline height and the class.
    const event = new Event('transitionend') as TransitionEvent
    Object.defineProperty(event, 'propertyName', { value: 'height' })
    card.dispatchEvent(event)
    expect(card.classList.contains('dsh-composer-fold-anim')).toBe(false)
    expect(card.style.height).toBe('')

    // Expanding runs the same envelope in reverse.
    setComposerCollapsed(false)
    expect(card.classList.contains('dsh-composer-fold-anim')).toBe(true)
    expect(card.style.height).toBe('100px')
    card.dispatchEvent(event)
    expect(card.style.height).toBe('')
  })
})
