import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ExtensionView } from '@kothar/extension-api'
import { startCore } from '@kothar/core/main'
import type { Adapter, ClientMessage, CoreMessage, SessionOptions } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import home from '../home/index.ts'
import { createArtifactsExtension, MAX_HTML_BYTES, openerFor, slugOf } from './index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean) {
  for (let i = 0; i < 600 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error('timed out')
}

async function start() {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-av-')))
  const sessions: { options: SessionOptions; prompt?: string }[] = []
  const held: Adapter = {
    id: 'held',
    kotharMcp: true,
    detect: async () => ({ installed: true, signedIn: true }),
    start(_machine, options, emit) {
      const session: (typeof sessions)[number] = { options }
      sessions.push(session)
      return {
        prompt(text) {
          session.prompt = text
          emit({ type: 'turn.started' })
        },
        interrupt: () => emit({ type: 'turn.completed', error: 'Interrupted' }),
        respond() {},
        close() {},
      }
    },
  }
  const env = { KOTHAR_ENGINE: 'held', KOTHAR_GARAGE: garage, KOTHAR_WORK: join(garage, 'work'), KOTHAR_PORT: '0' }
  const kothar = await startCore({ env, adapters: [held], extensions: [home, createArtifactsExtension()], machine: sandboxingMachine })
  cleanups.push(async () => {
    await kothar.close(true)
    rmSync(garage, { recursive: true, force: true })
  })
  const { core } = kothar
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const handle = (message: ClientMessage) => core.handle(message, (m) => messages.push(m))
  const create = (name: string) => {
    handle({ type: 'chat.create', name })
    return core.chats().findLast((c) => c.name === name)!.id
  }
  const tool = async (chatId: string, name: string, args: object = {}) => {
    handle({ type: 'chat.send', chatId, text: 'Go' })
    const options = sessions.at(-1)!.options
    const response = await fetch(`http://127.0.0.1:${kothar.port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.kotharMcp!.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    const result = JSON.parse(await response.text()).result
    handle({ type: 'chat.interrupt', chatId })
    return { isError: result.isError === true, text: result.content[0].text as string, instructions: options.instructions }
  }
  const views = (chatId: string) => messages.filter((m) => m.type === 'extension.panel' && m.chatId === chatId)
  const panel = async (chatId: string, action?: { name: string; value?: unknown }): Promise<ExtensionView> => {
    const seen = views(chatId).length
    const where = { chatId, extension: 'artifacts', panel: 'artifacts' }
    handle(action ? ({ type: 'extension.panel.action', ...where, action } as ClientMessage) : { type: 'extension.panel.get', ...where })
    await until(() => views(chatId).length > seen)
    const shown = views(chatId).at(-1)
    if (shown?.type !== 'extension.panel' || !shown.view) throw new Error(shown?.type === 'extension.panel' ? shown.error : 'no view')
    return shown.view
  }
  return { core, garage, sessions, handle, create, tool, panel, messages }
}

// Every node of a view, depth first.
function nodes(view: ExtensionView): ExtensionView[] {
  const children =
    view.type === 'stack' || view.type === 'row' || view.type === 'card' ? view.children : view.type === 'split' ? [view.side, view.main] : []
  return [view, ...children.flatMap(nodes)]
}
const nodeOf = <T extends ExtensionView['type']>(view: ExtensionView, type: T) =>
  nodes(view).find((n): n is Extract<ExtensionView, { type: T }> => n.type === type)

const PAGE = '<!doctype html><title>Chart</title><svg><rect width="4" height="4"/></svg>'

it('makes, updates, lists and reads artifacts as plain files in the space, with nothing in any prompt', async () => {
  const { garage, create, tool, sessions } = await start()
  const app = create('App')
  const made = await tool(app, 'create_artifact', { title: 'Sales chart', html: PAGE, kind: 'chart', description: 'Q3 by region' })
  expect(made.isError).toBe(false)
  // Agents learn about artifacts from the tools alone.
  expect(made.instructions).not.toMatch(/artifact/i)
  const dir = join(garage, 'chats', app, 'artifacts', 'sales-chart')
  expect(readFileSync(join(dir, 'v1.html'), 'utf8')).toBe(PAGE)
  expect(JSON.parse(readFileSync(join(dir, 'artifact.json'), 'utf8'))).toMatchObject({
    title: 'Sales chart',
    kind: 'chart',
    description: 'Q3 by region',
    versions: [{ n: 1 }],
  })
  expect(JSON.parse(made.text)).toMatchObject({ name: 'sales-chart', version: 1, path: join(dir, 'v1.html') })

  // A second one with the same title gets a folder of its own.
  expect(JSON.parse((await tool(app, 'create_artifact', { title: 'Sales chart', html: '<p>2</p>' })).text).name).toBe('sales-chart-2')

  // A title two artifacts share is refused; the name picks one.
  expect((await tool(app, 'update_artifact', { artifact: 'Sales chart', html: '<p/>' })).text).toContain('name one of sales-chart, sales-chart-2')
  const updated = await tool(app, 'update_artifact', { artifact: 'sales-chart', html: '<p>v2</p>', change: 'Bigger bars' })
  expect(JSON.parse(updated.text)).toMatchObject({ name: 'sales-chart', version: 2 })
  expect(readFileSync(join(dir, 'v1.html'), 'utf8')).toBe(PAGE)
  expect(readFileSync(join(dir, 'v2.html'), 'utf8')).toBe('<p>v2</p>')
  expect(JSON.parse(readFileSync(join(dir, 'artifact.json'), 'utf8')).versions[1]).toMatchObject({ n: 2, change: 'Bigger bars' })

  const list = JSON.parse((await tool(app, 'list_artifacts')).text)
  expect(list.map((a: { name: string; version: number }) => [a.name, a.version]).sort()).toEqual([
    ['sales-chart', 2],
    ['sales-chart-2', 1],
  ])
  expect((await tool(app, 'read_artifact', { artifact: 'sales-chart' })).text).toContain('v2 of 2\n\n<p>v2</p>')
  expect((await tool(app, 'read_artifact', { artifact: 'sales-chart', version: 1 })).text).toContain(PAGE)
  expect((await tool(app, 'read_artifact', { artifact: 'sales-chart', version: 9 })).isError).toBe(true)
  expect((await tool(app, 'update_artifact', { artifact: 'nope', html: '<p/>' })).text).toContain('list_artifacts')

  // A worker shares its space's artifacts.
  const spawned = await tool(app, 'spawn_worker', { task: 'Look' })
  await until(() => sessions.at(-1)!.prompt === 'Look')
  const worker = JSON.parse(spawned.text).chatId as string
  expect((await tool(worker, 'update_artifact', { artifact: 'sales-chart', html: '<p>v3</p>' })).isError).toBe(false)
  expect(existsSync(join(dir, 'v3.html'))).toBe(true)

  // Another space doesn't see them; Home keeps none.
  expect(JSON.parse((await tool(create('Other'), 'list_artifacts')).text)).toEqual([])
  expect((await tool('main', 'create_artifact', { title: 'X', html: '<p/>' })).text).toContain('make it in a space')
})

it('refuses an artifact without a title or html, or too big', async () => {
  const { create, tool } = await start()
  const app = create('App')
  expect((await tool(app, 'create_artifact', { title: '!!!', html: ' ' })).isError).toBe(true)
  expect((await tool(app, 'create_artifact', { title: 'Big', html: 'x'.repeat(MAX_HTML_BYTES + 1) })).text).toContain('at most')
  // A title of punctuation still gets a folder.
  expect(JSON.parse((await tool(app, 'create_artifact', { title: '!!!', html: '<p/>' })).text).name).toBe('artifact')
})

it('says in the chat when an artifact is made or updated, and the note opens the popup on it', async () => {
  const { create, tool, panel, messages } = await start()
  const app = create('App')
  await tool(app, 'create_artifact', { title: 'One', html: '<p>1</p>' })
  await tool(app, 'create_artifact', { title: 'Two', html: '<p>2</p>' })
  await tool(app, 'update_artifact', { artifact: 'one', html: '<p>1b</p>' })
  const notes = messages.flatMap((m) =>
    m.type === 'chat.entry' && m.chatId === app && m.entry.type === 'extension.note' ? [m.entry] : [],
  )
  expect(notes.map((n) => [n.text, n.panel, n.extension])).toEqual([
    ['Made the artifact “One”', 'artifacts', 'artifacts'],
    ['Made the artifact “Two”', 'artifacts', 'artifacts'],
    ['Updated the artifact “One” to v2', 'artifacts', 'artifacts'],
  ])
  // The popup opens on the one last touched.
  const view = await panel(app)
  expect(nodeOf(view, 'heading')).toBeDefined()
  expect(nodeOf(view, 'html')).toMatchObject({ html: '<p>1b</p>', label: 'One', web: false })
})

it('opens as a popup with a sidebar entry and keys, in spaces only', async () => {
  const { create, handle, messages } = await start()
  const app = create('App')
  const panelsOf = (chatId: string) => {
    handle({ type: 'context.get', chatId })
    const shown = messages.findLast((m) => m.type === 'chat.extensions' && m.chatId === chatId)
    return shown?.type === 'chat.extensions' ? shown.panels : []
  }
  expect(panelsOf(app)).toContainEqual({
    extension: 'artifacts',
    id: 'artifacts',
    title: 'Artifacts',
    placement: 'popup',
    shortcut: 'Mod+Shift+A',
    sidebar: true,
  })
  expect(panelsOf('main').some((p) => p.extension === 'artifacts')).toBe(false)
})

it('shows an artifact sandboxed, by version, as source, from the web only when the space allows, and deletes it', async () => {
  const { garage, create, tool, panel, handle } = await start()
  const app = create('App')
  expect(JSON.stringify(await panel(app))).toContain('No artifacts yet')
  await tool(app, 'create_artifact', { title: 'Mock', html: '<p>v1</p>', kind: 'mockup' })
  await tool(app, 'update_artifact', { artifact: 'mock', html: '<p>v2</p>' })

  let view = await panel(app)
  expect(nodeOf(view, 'split')).toBeDefined()
  expect(nodeOf(view, 'list')!.items).toEqual([expect.objectContaining({ key: 'mock', label: 'Mock', detail: 'v2', selected: true })])
  expect(nodeOf(view, 'html')).toEqual({ type: 'html', html: '<p>v2</p>', label: 'Mock', web: false })
  expect(nodeOf(view, 'copy')).toMatchObject({ text: '<p>v2</p>', label: 'Copy HTML' })
  expect(nodeOf(view, 'download')).toMatchObject({ text: '<p>v2</p>', filename: 'mock-v2.html', mimeType: 'text/html' })
  expect(nodeOf(view, 'switch')).toMatchObject({ setting: 'web', value: false })
  const labels = nodes(view).flatMap((n) => (n.type === 'button' ? [n.label] : []))
  expect(labels).toEqual(['Preview', 'Source', 'Open in browser', 'Delete', 'v1', 'v2'])

  view = await panel(app, { name: 'version', value: 1 })
  expect(nodeOf(view, 'html')!.html).toBe('<p>v1</p>')
  expect(nodeOf(view, 'download')!.filename).toBe('mock-v1.html')

  view = await panel(app, { name: 'mode', value: 'source' })
  expect(nodeOf(view, 'html')).toBeUndefined()
  expect(nodeOf(view, 'code')).toMatchObject({ text: '<p>v1</p>', language: 'html' })
  view = await panel(app, { name: 'mode', value: 'preview' })

  // The space's switch lets its artifacts load from the web.
  handle({ type: 'extension.space.set', chatId: app, extension: 'artifacts', key: 'web', value: true })
  view = await panel(app)
  expect(nodeOf(view, 'html')!.web).toBe(true)
  expect(nodeOf(view, 'switch')!.value).toBe(true)

  view = await panel(app, { name: 'delete', value: 'mock' })
  expect(existsSync(join(garage, 'chats', app, 'artifacts', 'mock'))).toBe(false)
  expect(JSON.stringify(view)).toContain('No artifacts yet')
})

it('opens a file with the platform’s own opener', () => {
  expect(openerFor('darwin', '/a/v1.html')).toEqual(['open', ['/a/v1.html']])
  expect(openerFor('linux', '/a/v1.html')).toEqual(['xdg-open', ['/a/v1.html']])
  expect(openerFor('win32', 'C:\\a\\v1.html')).toEqual(['cmd', ['/c', 'start', '', 'C:\\a\\v1.html']])
  expect(slugOf('Sales: Q3 (draft)')).toBe('sales-q3-draft')
})
