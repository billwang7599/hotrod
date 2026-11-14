// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ClientMessage, EngineInfo, EngineToolRow, EngineToolsSettings } from '@kothar/core/shared'
import { SettingsDialog } from './settings.tsx'
import { ENGINE_TOOLS_OFF } from './settings/engine-tools.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLElement
beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const engine = (id: string, enabled = true): EngineInfo => ({ id, enabled, installed: true, signedIn: true })
const tool = (name: string, more: Partial<EngineToolRow> = {}): EngineToolRow => ({
  name,
  group: 'core',
  defaultOn: true,
  on: true,
  ...more,
})
const TOOLS: EngineToolRow[] = [
  tool('Bash', { capability: 'shell' }),
  tool('Agent', { capability: 'subagents', group: 'replaced', defaultOn: false, on: false, replacedBy: 'Workers' }),
  tool('CronCreate', { capability: 'scheduling', group: 'outside', defaultOn: false, on: false }),
  tool('Shiny', { isNew: true }),
]
const settingsOf = (more: Partial<EngineToolsSettings> = {}, tools = TOOLS, enabled = true): EngineToolsSettings => ({
  enabled: true,
  engines: [
    { engine: 'claude-code', name: 'Claude Code', enabled, tools },
    { engine: 'pi', name: 'pi', enabled: true, tools: [tool('bash')] },
  ],
  ...more,
})

function render(engineTools: EngineToolsSettings, engines = [engine('claude-code'), engine('pi', false)]) {
  const sent: ClientMessage[] = []
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <SettingsDialog
              open
              page="engines"
              openPage={() => {}}
              close={() => {}}
              engines={engines}
              engineTools={engineTools}
              accounts={[]}
              contextDefaults={{ agents: true, folders: true, files: true }}
              extensions={[]}
              modelLists={{ chat: [], planning: [], searching: [], workers: [] }}
              workFolder={{ defaultPath: '/w', canSandbox: true }}
              chooseWorkFolder={() => {}}
              connected
              send={(m) => sent.push(m)}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
  return sent
}

const page = () => document.querySelector('[role="dialog"]')!
const switchOf = (label: string) => page().querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`)

test('lists the tools of each engine that is on, with its group, a switch each, and new ones marked', () => {
  render(settingsOf())
  expect(page().querySelector('section[aria-label="Claude Code tools"]')).not.toBeNull()
  expect(page().querySelector('section[aria-label="pi tools"]')).toBeNull()
  const text = page().textContent!
  expect(text).toContain('Kothar has its own')
  expect(text).toContain('Outside Kothar')
  expect(text).toContain('Workers instead')
  expect(text).toContain('New')
  expect(switchOf('Bash on')!.getAttribute('aria-checked')).toBe('true')
  expect(switchOf('Agent on')!.getAttribute('aria-checked')).toBe('false')
})

test('switches any tool, a core one too, saving a choice only when it differs from the default', () => {
  const sent = render(settingsOf())
  act(() => switchOf('Bash on')!.click())
  act(() => switchOf('CronCreate on')!.click())
  expect(sent).toEqual([
    { type: 'engineTools.setTool', engine: 'claude-code', tool: 'Bash', on: false },
    { type: 'engineTools.setTool', engine: 'claude-code', tool: 'CronCreate', on: true },
  ])
  const back = render(settingsOf({}, [tool('Bash', { capability: 'shell', on: false, saved: true })]))
  act(() => switchOf('Bash on')!.click())
  expect(back).toEqual([{ type: 'engineTools.setTool', engine: 'claude-code', tool: 'Bash' }])
})

test('warns when a core kind of work has no tool left, and offers Reset once something was changed', () => {
  const sent = render(settingsOf({}, [tool('Bash', { capability: 'shell', on: false, saved: true }), tool('Read', { capability: 'read' })]))
  expect(page().textContent).toContain("Claude Code can't run commands any more, and Kothar has no tool of its own for that yet.")
  expect(page().textContent).not.toContain("can't read files any more")
  const reset = [...page().querySelectorAll('button')].find((b) => b.textContent === 'Reset to defaults')!
  act(() => reset.click())
  expect(sent).toEqual([{ type: 'engineTools.reset', engine: 'claude-code' }])
  render(settingsOf())
  expect([...page().querySelectorAll('button')].some((b) => b.textContent === 'Reset to defaults')).toBe(false)
})

test("the Engine tools master switch turns every engine's tools off: per-tool switches show off and can't change", () => {
  const sent = render(settingsOf({ enabled: false }))
  expect(page().textContent).toContain(ENGINE_TOOLS_OFF)
  expect(switchOf('Bash on')!.getAttribute('aria-checked')).toBe('false')
  expect(switchOf('Bash on')!.disabled).toBe(true)
  expect(switchOf('All Claude Code tools')!.disabled).toBe(true)
  act(() => switchOf('Engine tools')!.click())
  expect(sent).toEqual([{ type: 'engineTools.setEnabled', enabled: true }])
})

test("an engine's own master switch turns all its tools off, with a warning, keeping the rows greyed out", () => {
  const sent = render(settingsOf({}, TOOLS, false))
  expect(page().textContent).toContain("All off: Claude Code can't run commands, edit or read files itself.")
  expect(switchOf('Bash on')!.disabled).toBe(true)
  expect(page().textContent).not.toContain(ENGINE_TOOLS_OFF)
  act(() => switchOf('All Claude Code tools')!.click())
  expect(sent).toEqual([{ type: 'engineTools.setEnabled', engine: 'claude-code', enabled: true }])
})
