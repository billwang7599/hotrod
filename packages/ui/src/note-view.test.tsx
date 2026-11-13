// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ClientMessage, NoteViewInfo } from '@kothar/core/shared'
import { NoteView } from './chat/note-view.tsx'
import { foldSteps, noteViewKey, type Item, type PanelView } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const view = { id: 'run', key: 'r1' }

const show = (sent: ClientMessage[], offered?: NoteViewInfo[], views?: Record<string, PanelView>) =>
  act(() =>
    root.render(
      <Tooltip.Provider delayDuration={0}>
        <NoteView chatId="c" extension="deep-research" view={view} text="Deep research: Greek letters?" offered={offered} views={views} connected send={(m) => sent.push(m)} />
      </Tooltip.Provider>,
    ),
  )

test('a live card asks for its view, draws it, sends its buttons back, and asks again when the extensions draw', () => {
  const sent: ClientMessage[] = []
  const offered = [{ extension: 'deep-research', id: 'run' }]
  show(sent, offered)
  expect(sent).toEqual([{ type: 'extension.noteView.get', chatId: 'c', extension: 'deep-research', noteView: 'run', key: 'r1' }])
  expect(container.textContent).toContain('Loading')
  const views = {
    [noteViewKey('c', 'deep-research', 'run', 'r1')]: {
      view: { type: 'stack' as const, children: [{ type: 'badge' as const, text: 'Researching 1 of 2' }, { type: 'button' as const, label: 'Stop', action: { name: 'stop' } }] },
    },
  }
  show(sent, offered, views)
  expect(container.textContent).toContain('Researching 1 of 2')
  act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Stop')!.click())
  expect(sent.at(-1)).toEqual({ type: 'extension.noteView.action', chatId: 'c', extension: 'deep-research', noteView: 'run', key: 'r1', action: { name: 'stop' } })
  // The chat's extensions drew again (a new list): it asks again.
  const before = sent.length
  show(sent, [{ extension: 'deep-research', id: 'run' }], views)
  expect(sent.length).toBe(before + 1)
})

test('shows the note’s text while the extension can’t draw it', () => {
  const sent: ClientMessage[] = []
  show(sent, [])
  expect(sent).toEqual([])
  expect(container.textContent).toBe('Deep research: Greek letters?')
})

test('a live card stays in view when its turn’s steps fold', () => {
  const items: Item[] = [
    { kind: 'user', text: 'Research it' },
    { kind: 'tool', toolId: 't1', name: 'deep_research', summary: '', state: 'done', output: '' },
    { kind: 'note', text: 'Deep research', extension: 'deep-research', view },
    { kind: 'tool', toolId: 't2', name: 'read', summary: '', state: 'done', output: '' },
    { kind: 'text', text: 'Done' },
  ]
  const rows = foldSteps(items, false)
  expect(rows.some((r) => 'item' in r && r.item.kind === 'note')).toBe(true)
})
