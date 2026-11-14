// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  PERMISSION_DEFAULTS,
  PERMISSION_SWITCHES,
  type ClientMessage,
  type EngineInfo,
  type ModelLists,
  type ExtensionInfo,
  type SetupState,
  type PromptInfo,
  type WorkersSettings,
  type WorkFolder,
} from '@kothar/core/shared'
import type { ExtensionSetting } from '@kothar/extension-api'
import { PERMISSIONS } from './context-panel.tsx'
import { SettingsDialog, type SettingsPage } from './settings.tsx'
import { WorkFolderDialog } from './settings/work-folder.tsx'

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

const workFolder: WorkFolder = { defaultPath: '/garage/work', canSandbox: true }

function render(props: Partial<Parameters<typeof WorkFolderDialog>[0]> = {}, sent: ClientMessage[] = []) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <WorkFolderDialog
              open
              workFolder={workFolder}
              connected
              send={(m) => sent.push(m)}
              toasts={[]}
              {...props}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
  return sent
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement
const button = (name: string) =>
  [...dialog().querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement | undefined
const type = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('on first run it offers the default, shown, or a typed folder, and has no way out but choosing', () => {
  const sent = render()
  expect(dialog().textContent).toContain('Choose a work folder')
  expect(dialog().textContent).toContain(workFolder.defaultPath)
  expect(button('Cancel')).toBeUndefined()
  act(() => button('Use default')!.click())
  expect(sent).toEqual([{ type: 'workFolder.set', path: workFolder.defaultPath }])

  type(dialog().querySelector('input')!, ' /elsewhere/work ')
  act(() => button('Use this folder')!.click())
  expect(sent.at(-1)).toEqual({ type: 'workFolder.set', path: '/elsewhere/work' })
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(dialog()).not.toBeNull()
})

test('shows a refusal that arrives after choosing, and picks with the desktop picker when there is one', async () => {
  const toasts = [{ id: 1, message: 'an old error' }]
  const pickFolder = vi.fn(async () => '/picked')
  const sent = render({ toasts, pickFolder })
  act(() => button('Use default')!.click())
  expect(dialog().textContent).not.toContain('an old error')
  render({ toasts: [...toasts, { id: 2, message: "/ can't be the work folder" }], pickFolder }, sent)
  expect(dialog().textContent).toContain("/ can't be the work folder")

  await act(async () => button('Choose…')!.click())
  expect(pickFolder).toHaveBeenCalledWith('Choose a work folder')
  expect(sent.at(-1)).toEqual({ type: 'workFolder.set', path: '/picked' })
})

function renderSettings(
  workFolder: WorkFolder,
  sent: ClientMessage[] = [],
  more: { page?: SettingsPage; workers?: WorkersSettings; corePrompts?: PromptInfo[] } = {},
) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <SettingsDialog
              open
              page={more.page ?? 'work'}
              workers={more.workers}
              corePrompts={more.corePrompts}
              openPage={() => {}}
              close={() => {}}
              engines={[]}
              accounts={[]}
              contextDefaults={{ agents: true, folders: true, files: true }}
              extensions={[]}
              modelLists={{ chat: [], planning: [], searching: [], workers: [] }}
              workFolder={workFolder}
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

test('Settings → Workers: agents’ switch, the limit for every child, and the instructions as an editable prompt', () => {
  const workers: WorkersSettings = {
    start: true,
    limit: 4,
    instructions: { id: 'instructions', label: 'When to start workers', where: 'instructions', default: 'Delegate.', text: 'Delegate.' },
  }
  const sent = renderSettings(workFolder, [], { page: 'workers', workers })
  expect([...dialog().querySelectorAll('h2')].map((h) => h.textContent)).toContain('Workers')
  expect(dialog().querySelector('#prompt-workers-instructions')).not.toBeNull()
  act(() => dialog().querySelector<HTMLButtonElement>('button[aria-label="Let agents start workers"]')!.click())
  const limit = dialog().querySelector<HTMLInputElement>('input[aria-label="Max running per chat"]')!
  type(limit, '2')
  act(() => limit.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(sent).toEqual([
    { type: 'workers.set', start: false },
    { type: 'workers.set', limit: 2 },
  ])
  // Not an extension any more: it isn't on the extensions page.
  expect([...dialog().querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toContain('Workers')
})

test('Settings → Prompts edits Kothar’s own prompts, each where the Inspector’s Edit link scrolls to', () => {
  const combine: PromptInfo = { id: 'combine', label: 'What you can use', where: 'instructions', default: 'Combine them.', text: 'Combine them.' }
  const sent = renderSettings(workFolder, [], { page: 'prompts', corePrompts: [combine] })
  const box = dialog().querySelector<HTMLElement>('#prompt-kothar-combine')!.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(box, 'Mix them.')
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => box.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(sent).toEqual([{ type: 'corePrompt.set', id: 'combine', text: 'Mix them.' }])
})

test('Settings → Work folder sets the default of each permission every chat follows', () => {
  expect(PERMISSION_SWITCHES).toContain('autoFetch')
  expect(PERMISSIONS.autoFetch.label).toBe('Fetch web pages without asking')
  expect(PERMISSIONS.autoNetworkCommands.label).toBe('Run network commands without asking')
  expect(PERMISSION_DEFAULTS.autoFetch).toBe(true)
  expect(PERMISSION_DEFAULTS.autoNetworkCommands).toBe(false)
  expect(PERMISSIONS.autoEnvCommands.label).toBe('Let commands use .env files without asking')
  expect(PERMISSION_DEFAULTS.autoEnvCommands).toBe(false)
  for (const name of PERMISSION_SWITCHES) {
    const toggle = () =>
      dialog().querySelector(`[aria-label="${PERMISSIONS[name].label}"]`) as HTMLButtonElement
    const sent = renderSettings({ ...workFolder, path: '/garage/work' })
    expect(toggle().getAttribute('aria-checked')).toBe(String(PERMISSION_DEFAULTS[name]))
    act(() => toggle().click())
    expect(sent).toEqual([{ type: 'permission.setDefault', name, enabled: !PERMISSION_DEFAULTS[name] }])
    renderSettings({ ...workFolder, path: '/garage/work', [name]: !PERMISSION_DEFAULTS[name] }, sent)
    expect(toggle().getAttribute('aria-checked')).toBe(String(!PERMISSION_DEFAULTS[name]))
  }
})

test('Settings → Work folder picks the terminal Open in Terminal uses, where there is a choice', () => {
  const terminals = [
    { id: 'terminal', name: 'Terminal' },
    { id: 'ghostty', name: 'Ghostty' },
  ]
  const select = () => dialog().querySelector<HTMLButtonElement>('button[aria-label="Terminal"]')
  renderSettings(workFolder)
  expect(select()).toBeNull()
  const sent = renderSettings({ ...workFolder, terminals })
  expect(select()!.textContent).toBe('Automatic')
  act(() => select()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const options = [...document.querySelectorAll('[role="option"]')]
  expect(options.map((o) => o.textContent?.replace('✓', ''))).toEqual(['Automatic', 'Terminal', 'Ghostty'])
  const ghostty = options.find((o) => o.textContent?.endsWith('Ghostty'))!
  act(() => ghostty.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(sent).toEqual([{ type: 'terminal.set', terminal: 'ghostty' }])
  renderSettings({ ...workFolder, terminals, terminal: 'ghostty' })
  expect(select()!.textContent).toBe('Ghostty')
})

test('Settings has no Instructions page: the global AGENTS.md is edited in the Context panel', () => {
  renderSettings(workFolder)
  const tabs = [...dialog().querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  expect(tabs).toContain('Work folder')
  expect(tabs).not.toContain('Instructions')
})

test('from Settings it starts at the current folder and can be cancelled', () => {
  const close = vi.fn()
  render({ workFolder: { ...workFolder, path: '/current/work' }, close })
  expect(dialog().querySelector('input')!.value).toBe('/current/work')
  act(() => button('Cancel')!.click())
  expect(close).toHaveBeenCalled()
})

const setupExtension = (enabled: boolean, setup: Omit<SetupState, 'description'>, settings: ExtensionSetting[] = []): ExtensionInfo => ({
  id: 'browser',
  name: 'Browser',
  description: 'Browse the web.',
  enabled,
  settings,
  values: {},
  setup: { description: 'Downloads a browser.', ...setup },
})

function renderExtensions(extensions: ExtensionInfo[], page: SettingsPage, sent: ClientMessage[] = []) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <SettingsDialog
              open
              page={page}
              openPage={() => {}}
              close={() => {}}
              engines={[]}
              accounts={[]}
              contextDefaults={{ agents: true, folders: true, files: true }}
              extensions={extensions}
              modelLists={{ chat: [], planning: [], searching: [], workers: [] }}
              workFolder={workFolder}
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

const setupDialog = () => document.querySelector('[role="alertdialog"]') as HTMLElement | null
const setupButton = (name: string) =>
  [...setupDialog()!.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement

test('turning on an extension that is not set up asks to install it, shows the progress and can cancel', () => {
  const sent = renderExtensions([setupExtension(false, { status: 'checking' })], 'extensions')
  act(() => (dialog().querySelector('[aria-label="Browser"]') as HTMLButtonElement).click())
  expect(sent).toEqual([{ type: 'extension.setEnabled', extensionId: 'browser', enabled: true }])
  renderExtensions([setupExtension(true, { status: 'checking' })], 'extensions', sent)
  expect(setupDialog()).toBeNull()

  const missing = { status: 'missing', message: 'Browser not installed' } as const
  renderExtensions([setupExtension(true, missing)], 'extensions', sent)
  expect(setupDialog()!.textContent).toContain('Browser not installed')
  act(() => setupButton('Install').click())
  expect(sent.at(-1)).toEqual({ type: 'extension.install', extensionId: 'browser' })

  const installing = { ...missing, status: 'installing', progressText: 'Downloading Chromium', progress: 0.4 } as const
  renderExtensions([setupExtension(true, installing)], 'extensions', sent)
  expect(setupDialog()!.textContent).toContain('Downloading Chromium')
  expect(setupDialog()!.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('40')
  renderExtensions([setupExtension(true, { status: 'checking', message: missing.message })], 'extensions', sent)
  expect(setupDialog()!.textContent).toContain('Browser not installed')
  renderExtensions([setupExtension(true, { ...missing, error: 'Download failed' })], 'extensions', sent)
  expect(setupDialog()!.textContent).toContain('Download failed')
  act(() => setupButton('Install').click())
  renderExtensions([setupExtension(true, { status: 'installing' })], 'extensions', sent)
  act(() => setupButton('Cancel').click())
  expect(sent.slice(-2)).toEqual([
    { type: 'extension.install', extensionId: 'browser' },
    { type: 'extension.cancelInstall', extensionId: 'browser' },
  ])
  expect(setupDialog()).toBeNull()

  renderExtensions([setupExtension(false, { status: 'missing', message: 'Browser not installed' })], 'extensions', sent)
  act(() => (dialog().querySelector('[aria-label="Browser"]') as HTMLButtonElement).click())
  renderExtensions([setupExtension(true, { status: 'checking', message: 'Browser not installed' })], 'extensions', sent)
  renderExtensions([setupExtension(true, { status: 'ready', message: 'Browser installed' })], 'extensions', sent)
  expect(setupDialog()).toBeNull()
})

test("an extension that didn't load is listed off, its switch disabled and the reason under it", () => {
  const loadError = "@playwright/mcp isn't installed. Run npm install in the Kothar folder, then restart Kothar."
  const broken: ExtensionInfo = { id: 'browser', name: 'browser', description: '', enabled: false, settings: [], values: {}, loadError }
  const sent = renderExtensions([broken], 'extensions')
  const toggle = dialog().querySelector('[aria-label="browser"]') as HTMLButtonElement
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(toggle.disabled).toBe(true)
  expect(dialog().textContent).toContain(`Couldn't load: ${loadError}`)
  act(() => toggle.click())
  expect(sent).toEqual([])
})

test("an extension's page shows its setup, with Install while it is missing, even when it has no settings", () => {
  const sent = renderExtensions([setupExtension(true, { status: 'missing', message: 'Browser not installed' })], 'extension:browser')
  const tabs = [...dialog().querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  expect(tabs).toContain('Browser')
  expect(dialog().textContent).toContain('Browser not installed')
  act(() => ([...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Install') as HTMLElement).click())
  expect(sent).toEqual([{ type: 'extension.install', extensionId: 'browser' }])
  renderExtensions([setupExtension(true, { status: 'ready', message: 'Browser installed' })], 'extension:browser', sent)
  expect(dialog().textContent).toContain('Browser installed')
  expect([...dialog().querySelectorAll('button')].some((b) => b.textContent === 'Install')).toBe(false)
})

test("an extension's web addresses are links, in its setup and its settings", () => {
  const url = 'https://chromewebstore.google.com/detail/playwright-extension/abc'
  const token: ExtensionSetting = { key: 'token', label: 'Token', description: `Copy it from ${url}.`, type: 'text', default: '' }
  const extension = setupExtension(true, { status: 'missing' }, [token])
  renderExtensions([{ ...extension, setup: { ...extension.setup!, description: `Add it (${url}), then wait.` } }], 'extension:browser')
  const links = [...dialog().querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])
  expect(links).toEqual([
    [url, url],
    [url, url],
  ])
  expect(dialog().textContent).toContain(`Add it (${url}), then wait.`)
})

test("an extension's text setting saves on blur and resets to its default while it differs", () => {
  const notes = { key: 'notes', label: 'Notes', type: 'text', default: 'Be brief.', rows: 3 } satisfies ExtensionSetting
  const notesExtension = (value: string): ExtensionInfo => ({
    id: 'tester',
    name: 'Tester',
    description: 'For tests.',
    enabled: true,
    settings: [notes],
    values: { notes: value },
  })
  const area = () => dialog().querySelector('textarea[aria-label="Notes"]') as HTMLTextAreaElement
  const reset = () => button('Reset to default')
  const edit = (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(area(), value)
      area().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const blur = () => act(() => area().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))

  const sent = renderExtensions([notesExtension(notes.default)], 'extension:tester')
  expect(area().value).toBe(notes.default)
  expect(area().rows).toBe(notes.rows)
  expect(reset()).toBeUndefined()
  blur()
  expect(sent).toEqual([])

  edit('Be thorough.\nCite files.')
  expect(sent).toEqual([])
  expect(reset()).toBeDefined()
  blur()
  expect(sent).toEqual([{ type: 'extension.setValue', extensionId: 'tester', key: 'notes', value: 'Be thorough.\nCite files.' }])

  renderExtensions([notesExtension('Be thorough.\nCite files.')], 'extension:tester', sent)
  act(() => reset()!.click())
  expect(sent.at(-1)).toEqual({ type: 'extension.setValue', extensionId: 'tester', key: 'notes', value: '' })
  expect(area().value).toBe(notes.default)
  renderExtensions([notesExtension(notes.default)], 'extension:tester', sent)
  expect(area().value).toBe(notes.default)
  expect(reset()).toBeUndefined()

  edit('  ')
  blur()
  expect(area().value).toBe(notes.default)
  expect(sent.at(-1)).toEqual({ type: 'extension.setValue', extensionId: 'tester', key: 'notes', value: '' })
})

test('Settings → Models lists each role once across engines, each model with its own thinking level', () => {
  Element.prototype.scrollIntoView = vi.fn()
  const cc: EngineInfo = {
    id: 'claude-code',
    name: 'Claude Code',
    enabled: true,
    installed: true,
    signedIn: true,
    thinking: ['low', 'medium', 'high'],
    defaultThinking: 'medium',
    models: [
      { id: 'opus', label: 'Opus' },
      { id: 'haiku', label: 'Haiku', thinking: [] },
      { id: 'sonnet', label: 'Sonnet', thinking: ['low', 'high'] },
    ],
  }
  const pi: EngineInfo = {
    id: 'pi',
    enabled: true,
    installed: true,
    signedIn: true,
    thinking: ['off', 'low', 'high'],
    models: [{ id: 'p/one', label: 'One' }],
  }
  const lists: ModelLists = {
    chat: [{ engine: 'claude-code', model: 'opus', thinking: 'medium' }],
    planning: [
      { engine: 'claude-code', model: 'opus', thinking: 'high' },
      { engine: 'claude-code', model: 'haiku' },
      { engine: 'pi', model: 'p/one', thinking: 'off' },
    ],
    searching: [],
    workers: [],
  }
  const sent: ClientMessage[] = []
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <SettingsDialog
              open
              page="models"
              openPage={() => {}}
              close={() => {}}
              engines={[cc, pi]}
              accounts={[]}
              contextDefaults={{ agents: true, folders: true, files: true }}
              extensions={[]}
              modelLists={lists}
              workFolder={workFolder}
              chooseWorkFolder={() => {}}
              connected
              send={(m) => sent.push(m)}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
  const select = (label: string) => dialog().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  const open = (label: string) =>
    act(() => select(label)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.replace('✓', ''))
  const pick = (text: string) => {
    const item = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.endsWith(text))!
    act(() => item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  }

  // One section, not one per engine, and no default anywhere.
  expect(dialog().querySelectorAll('section[aria-label="Models"]')).toHaveLength(1)
  expect(dialog().textContent).not.toMatch(/default/i)
  expect(dialog().querySelector('ol[aria-label="Planning models"]')!.textContent).toContain('One · pi')
  expect(select('Thinking for Opus · Claude Code in Planning')!.textContent).toBe('High')
  expect(select('Thinking for Haiku · Claude Code in Planning')).toBeNull()
  // Empty roles run what Chat does, and the Chat list's only model can't be removed.
  expect(dialog().textContent?.match(/Same as Chat/g)).toHaveLength(2)
  expect(select('Remove Opus · Claude Code')!.disabled).toBe(true)

  open('Thinking for One · pi in Planning')
  expect(options()).toEqual(['Off', 'Low', 'High'])
  pick('High')
  expect(sent.at(-1)).toEqual({
    type: 'models.setList',
    role: 'planning',
    models: [lists.planning[0], lists.planning[1], { engine: 'pi', model: 'p/one', thinking: 'high' }],
  })

  // Adding a model offers every engine's, grouped; the core gives it the level it runs at.
  open('Add a Searching model')
  expect([...document.querySelectorAll('[role="group"]')].map((g) => g.firstElementChild?.textContent)).toEqual([
    'Claude Code',
    'pi',
  ])
  pick('Sonnet · Claude Code')
  expect(sent.at(-1)).toEqual({
    type: 'models.setList',
    role: 'searching',
    models: [{ engine: 'claude-code', model: 'sonnet' }],
  })
})

test("Settings' scrolling nav and page keep their scrollbars inset, the page's below the close button", () => {
  renderSettings(workFolder)
  const nav = dialog().querySelector('[role="tablist"]')!
  const page = dialog().querySelector('[role="tabpanel"]')!
  expect(nav.classList).toContain('scroll-inset')
  expect(page.classList).toContain('scroll-inset')
  expect(page.className).toContain('[--scroll-top:48px]')
})

test('an extension with nothing to set gets no page; one with settings gets the header, its switch and what it does', () => {
  const plain: ExtensionInfo = { id: 'plain', name: 'Plain', description: 'Does one quiet thing.', enabled: true, settings: [], values: {}, uses: ['events'] }
  renderExtensions([plain], 'extensions')
  expect([...dialog().querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).not.toContain('Plain')

  const setting = { key: 'n', label: 'Count', type: 'number', default: 1 } satisfies ExtensionSetting
  const sent = renderExtensions([{ ...plain, settings: [setting], values: { n: 1 }, uses: ['events', 'settings'] }], 'extension:plain')
  expect([...dialog().querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toContain('Plain')
  const text = dialog().textContent
  expect(text).toContain('Does one quiet thing.')
  expect(text).toContain('Built-in extension')
  expect(text).toContain('What it does')
  expect(dialog().querySelector('input[aria-label="Count"]')).not.toBeNull()
  const toggle = dialog().querySelector('[aria-label="Plain on"]') as HTMLButtonElement
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  act(() => toggle.click())
  expect(sent).toEqual([{ type: 'extension.setEnabled', extensionId: 'plain', enabled: false }])
})

test('a setting that needs an extension that is off is greyed out and says which; so is an extension that requires one', () => {
  const shown = { key: 'shown', label: 'Show as workers', type: 'boolean', default: false, requires: 'workers' } satisfies ExtensionSetting
  const depth = { key: 'depth', label: 'Depth', type: 'number', default: 1 } satisfies ExtensionSetting
  const extension: ExtensionInfo = {
    id: 'research',
    name: 'Research',
    description: '',
    enabled: true,
    settings: [shown, depth],
    values: { shown: false, depth: 1 },
    blockedSettings: { shown: 'Needs the Workers extension' },
  }
  renderExtensions([extension], 'extension:research')
  const toggle = dialog().querySelector('[aria-label="Show as workers"]') as HTMLButtonElement
  expect(toggle.disabled).toBe(true)
  expect([...dialog().querySelectorAll('[data-testid="extension-blocked"]')].map((e) => e.textContent)).toEqual(['Needs the Workers extension'])
  expect((dialog().querySelector('input[aria-label="Depth"]') as HTMLInputElement).disabled).toBe(false)

  renderExtensions([{ ...extension, enabled: false, blocked: 'Needs the Workers extension', blockedSettings: undefined }], 'extensions')
  const main = dialog().querySelector('[aria-label="Research"]') as HTMLButtonElement
  expect(main.disabled).toBe(true)
  expect(dialog().textContent).toContain('Needs the Workers extension')
})

test("an off extension with settings keeps its page, saying to turn it on, and its settings stay hidden", () => {
  const setting = { key: 'n', label: 'Count', type: 'number', default: 1 } satisfies ExtensionSetting
  renderExtensions([{ id: 'off', name: 'Offish', description: '', enabled: false, settings: [setting], values: { n: 1 } }], 'extension:off')
  expect(dialog().textContent).toContain('Turn Offish on to change its settings.')
  expect(dialog().querySelector('input[aria-label="Count"]')).toBeNull()
})

test('a community extension with settings gets a page too, with its version and author, while community extensions are on', () => {
  const community: ExtensionInfo = {
    id: 'counter',
    name: 'Counter',
    description: 'Counts words.',
    enabled: true,
    settings: [{ key: 'size', label: 'Size', type: 'number', default: 2 }],
    values: { size: 2 },
    community: { version: '1.2.0', author: 'Someone', uses: ['events'], source: 'marketplace' },
  }
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <SettingsDialog
              open
              page="extension:counter"
              openPage={() => {}}
              close={() => {}}
              engines={[]}
              accounts={[]}
              contextDefaults={{ agents: true, folders: true, files: true }}
              extensions={[community]}
              communityExtensions
              modelLists={{ chat: [], planning: [], searching: [], workers: [] }}
              workFolder={workFolder}
              chooseWorkFolder={() => {}}
              connected
              send={() => {}}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
  const text = dialog().textContent
  expect(text).toContain('Community extension · 1.2.0 by Someone')
  expect(text).toContain('Uses')
  expect(dialog().querySelector('input[aria-label="Size"]')).not.toBeNull()
})

test('an extension with only prompts gets a page with its Prompts: edit, Reset to default, and the Edited and Updated default badges', () => {
  const prompt = (text: string, more: object = {}) => ({
    id: 'rule',
    label: 'When to act',
    where: 'instructions' as const,
    default: 'Only when asked.',
    text,
    ...more,
  })
  const withPrompts = (text: string, more: object = {}): ExtensionInfo => ({
    id: 'quiet',
    name: 'Quiet',
    description: '',
    enabled: true,
    settings: [],
    values: {},
    prompts: [prompt(text, more)],
    fixedInstructions: true,
  })
  const area = () => dialog().querySelector('textarea[aria-label="When to act"]') as HTMLTextAreaElement
  const sent = renderExtensions([withPrompts('Only when asked.')], 'extension:quiet')
  expect([...dialog().querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toContain('Quiet')
  expect(dialog().querySelector('#prompt-quiet-rule')).not.toBeNull()
  expect(dialog().textContent).toContain('In every session’s instructions')
  expect(dialog().textContent).toContain('can’t be edited')
  expect(area().value).toBe('Only when asked.')
  expect(button('Reset to default')).toBeUndefined()

  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(area(), 'Whenever useful.')
    area().dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => area().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(sent).toEqual([{ type: 'extension.prompt.set', extensionId: 'quiet', promptId: 'rule', text: 'Whenever useful.' }])

  renderExtensions([withPrompts('Whenever useful.', { edited: true, updatedDefault: true })], 'extension:quiet', sent)
  expect(dialog().textContent).toContain('Edited')
  expect(dialog().textContent).toContain('Updated default')
  act(() => button('Reset to default')!.click())
  expect(sent.at(-1)).toEqual({ type: 'extension.prompt.set', extensionId: 'quiet', promptId: 'rule' })
  expect(area().value).toBe('Only when asked.')
})
