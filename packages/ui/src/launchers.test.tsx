// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { reloadLaunchers } from './launchers.ts'
import { AppearancePage } from './settings/appearance.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLElement

beforeEach(() => {
  localStorage.clear()
  reloadLaunchers()
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

test('Settings → Appearance picks where extension launchers go: Top by default, then Bottom or Hidden, and keeps it', () => {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <AppearancePage />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
  const select = () => container.querySelector<HTMLButtonElement>('button[aria-label="Extension launchers"]')!
  expect(select().textContent).toBe('Top')
  // The label is inline; what it means is in a hint.
  expect(container.textContent).toContain('Extension launchers')
  act(() => select().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const options = [...document.querySelectorAll('[role="option"]')]
  expect(options.map((o) => o.textContent?.replace('✓', ''))).toEqual(['Top', 'Bottom', 'Hidden'])
  const hidden = options.find((o) => o.textContent?.endsWith('Hidden'))!
  act(() => hidden.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(localStorage.getItem('kothar.launchers')).toBe('hidden')
  expect(select().textContent).toBe('Hidden')
})
