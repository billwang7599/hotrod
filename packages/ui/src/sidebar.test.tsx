// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { LAUNCHER_PLACES, placedLaunchers, placeLaunchers, reloadLaunchers, useLauncherPlace, type LauncherPlace } from './launchers.ts'
import { ChatNav, NameDialog, SidebarFooter, type Launcher, type NameRequest } from './sidebar.tsx'
import type { ChatView } from './state.ts'

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

const chat = (change: Partial<ChatView>): ChatView => ({
  id: 'c1',
  name: 'demo',
  folders: [],
  files: [],
  engine: 'fake',
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  items: [],
  draft: '',
  queue: [],
  ...change,
})

const HOME = chat({ id: 'main', name: 'Home', extension: 'home', createdAt: '2025-01-01T00:00:00.000Z' })
const SPACE = chat({ id: 's1', name: 'Kothar' })
const WORKER = chat({ id: 'w1', name: 'Worker', parentId: 's1', worker: true })

function render(chats: ChatView[], selected: string[] = []) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <ChatNav
              chats={chats}
              selectedId=""
              connected
              send={() => {}}
              select={(id) => selected.push(id)}
              askName={() => {}}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const spaces = () => container.querySelector('[role="group"][aria-labelledby="spaces-label"]')!
const names = (el: Element) => [...el.querySelectorAll('button[title]')].map((b) => b.textContent)
const rowOf = (name: string) =>
  [...container.querySelectorAll('button[title]')].find((b) => b.textContent === name) as HTMLButtonElement

test('Home sits above the spaces, outside their section, and still selects; Home and workers get no row menu', () => {
  const selected: string[] = []
  render([SPACE, WORKER, HOME], selected)
  expect(container.querySelector('#spaces-label')?.textContent).toBe('spaces')
  expect(names(spaces())).toEqual(['Kothar', 'Workerworker'])
  const home = rowOf('Home')
  expect(spaces().contains(home)).toBe(false)
  expect(home.compareDocumentPosition(spaces()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(home.querySelector('svg')).not.toBeNull()
  expect(container.querySelector('[aria-label="More for Home"]')).toBeNull()
  expect(container.querySelector('[aria-label="More for Kothar"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="More for Worker"]')).toBeNull()
  act(() => home.click())
  expect(selected).toEqual(['main'])
})

test('with Home off, only the spaces show', () => {
  render([SPACE, WORKER])
  expect(rowOf('Home')).toBeUndefined()
  expect(names(spaces())).toEqual(['Kothar', 'Workerworker'])
  expect(names(container)).toEqual(names(spaces()))
})

function Sidebar({ connected }: { connected: boolean }) {
  const [request, setRequest] = useState<NameRequest | null>(null)
  return (
    <>
      <ChatNav
        chats={[SPACE]}
        selectedId=""
        connected={connected}
        send={() => {}}
        select={() => {}}
        askName={setRequest}
        newSpaceKeys="Mod+N"
      />
      <SidebarFooter settingsKeys="Mod+," openSettings={() => {}} />
      <NameDialog request={request} connected={connected} send={() => {}} close={() => setRequest(null)} />
    </>
  )
}

function renderSidebar(connected = true) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <Sidebar connected={connected} />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const buttonsEnding = (label: string) =>
  [...container.querySelectorAll('button')].filter((b) => b.textContent?.endsWith(label)) as HTMLButtonElement[]

test('the sidebar has one New space button, under the spaces; it opens the name dialog and is off while disconnected', () => {
  renderSidebar()
  const [newSpace, ...more] = buttonsEnding('New space')
  expect(more).toEqual([])
  expect(newSpace!.closest('nav')).not.toBeNull()
  expect(newSpace!.hasAttribute('data-hint')).toBe(true)
  // Full width like the space rows, label on the left: the tooltip adds no wrapper around it.
  expect(newSpace!.parentElement!.tagName).toBe('NAV')
  expect(newSpace!.className).toContain('w-full')
  expect(newSpace!.className).not.toContain('self-end')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  act(() => newSpace!.click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  renderSidebar(false)
  expect(buttonsEnding('New space')[0]!.disabled).toBe(true)
  expect(buttonsEnding('Settings')[0]!.disabled).toBe(false)
})

const opened: string[] = []
const NOTES: Launcher = { key: 'extension:notes/notes', label: 'Notes', keys: 'Mod+Shift+N', open: () => opened.push('notes') }
const ARTIFACTS: Launcher = { key: 'extension:artifacts/artifacts', label: 'Artifacts', open: () => opened.push('artifacts') }

// The sidebar as main.tsx puts it together: the chats, then the footer, with launchers where the user put them.
function WithLaunchers() {
  const { top, bottom } = placedLaunchers(useLauncherPlace(), [NOTES, ARTIFACTS])
  return (
    <>
      <ChatNav chats={[SPACE, HOME]} selectedId="" connected send={() => {}} select={() => {}} askName={() => {}} launchers={top} />
      <SidebarFooter openSettings={() => {}} launchers={bottom} />
    </>
  )
}

function renderLaunchers() {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <WithLaunchers />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const launcherButton = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined
const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

test('launchers sit at the top by default: under Home, above the spaces, apart from Settings; they open their panel', () => {
  localStorage.clear()
  reloadLaunchers()
  opened.length = 0
  renderLaunchers()
  const notes = launcherButton('Notes')!
  const artifacts = launcherButton('Artifacts')!
  expect(notes.closest('nav')).not.toBeNull()
  expect(notes.closest('[role="group"]')!.getAttribute('aria-label')).toBe('Extensions')
  expect(follows(rowOf('Home'), notes)).toBe(true)
  expect(follows(notes, artifacts)).toBe(true)
  expect(follows(artifacts, spaces())).toBe(true)
  // Lined up with the chat rows, and the shortcut shows on hover; one without keys gets no tooltip.
  expect(notes.className).toContain('pl-7')
  expect(notes.hasAttribute('data-hint')).toBe(true)
  expect(artifacts.hasAttribute('data-hint')).toBe(false)
  // Settings is alone at the bottom.
  const footer = buttonsEnding('Settings')[0]!.parentElement!.closest('div.flex-col')!
  expect([...footer.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['⚙Settings'])
  act(() => notes.click())
  act(() => artifacts.click())
  expect(opened).toEqual(['notes', 'artifacts'])
})

test('Bottom moves the launchers above Settings, Hidden drops them, and the choice is saved', () => {
  localStorage.clear()
  reloadLaunchers()
  renderLaunchers()
  act(() => placeLaunchers('bottom'))
  expect(localStorage.getItem('kothar.launchers')).toBe('bottom')
  const notes = launcherButton('Notes')!
  expect(notes.closest('nav')).toBeNull()
  expect(follows(notes, buttonsEnding('Settings')[0]!)).toBe(true)
  expect(follows(launcherButton('Artifacts')!, buttonsEnding('Settings')[0]!)).toBe(true)
  act(() => placeLaunchers('hidden'))
  expect(launcherButton('Notes')).toBeUndefined()
  expect(launcherButton('Artifacts')).toBeUndefined()
  reloadLaunchers()
  expect(LAUNCHER_PLACES.map((p) => p.value)).toEqual<LauncherPlace[]>(['top', 'bottom', 'hidden'])
  localStorage.setItem('kothar.launchers', 'sideways')
  act(() => reloadLaunchers())
  expect(launcherButton('Notes')!.closest('nav')).not.toBeNull()
})
