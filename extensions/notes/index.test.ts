import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ExtensionView } from '@kothar/extension-api'
import { startCore } from '@kothar/core/main'
import type { Adapter, ClientMessage, CoreMessage, SessionOptions } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import home from '../home/index.ts'
import { createNotesExtension, noteIndex, noteText, parseNote, slugOf, type Note } from './index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean) {
  for (let i = 0; i < 600 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error('timed out')
}

async function start() {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-notes-')))
  const sessions: { chatId: string; options: SessionOptions; prompt?: string }[] = []
  const held: Adapter = {
    id: 'held',
    kotharMcp: true,
    detect: async () => ({ installed: true, signedIn: true }),
    start(_machine, options, emit) {
      const session: (typeof sessions)[number] = { chatId: '', options }
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
  const kothar = await startCore({
    env,
    adapters: [held],
    extensions: [home, createNotesExtension()],
    machine: sandboxingMachine,
  })
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
  // Starts a session for the chat and stops it again, returning what it was given.
  const session = (chatId: string, text = 'Hi') => {
    handle({ type: 'chat.send', chatId, text })
    const started = sessions.at(-1)!
    handle({ type: 'chat.interrupt', chatId })
    return started.options
  }
  const rpc = async (token: string, method: string, params: object) => {
    const response = await fetch(`http://127.0.0.1:${kothar.port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const raw = await response.text()
    if (!raw) throw new Error(`empty ${response.status} for ${method} ${JSON.stringify(params)}`)
    return JSON.parse(raw).result
  }
  const tool = async (chatId: string, name: string, args: object = {}) => {
    handle({ type: 'chat.send', chatId, text: 'Go' })
    const token = sessions.at(-1)!.options.kotharMcp!.token
    const result = await rpc(token, 'tools/call', { name, arguments: args })
    handle({ type: 'chat.interrupt', chatId })
    return { isError: result.isError === true, text: result.content[0].text as string }
  }
  const views = (chatId: string) => messages.filter((m) => m.type === 'extension.panel' && m.chatId === chatId)
  const panel = async (chatId: string, action?: { name: string; value?: unknown }): Promise<ExtensionView> => {
    const seen = views(chatId).length
    const where = { chatId, extension: 'notes', panel: 'notes' }
    handle(
      action
        ? ({ type: 'extension.panel.action', ...where, action } as ClientMessage)
        : { type: 'extension.panel.get', ...where },
    )
    await until(() => views(chatId).length > seen)
    const shown = views(chatId).at(-1)
    if (shown?.type !== 'extension.panel' || !shown.view) throw new Error(shown?.type === 'extension.panel' ? shown.error : 'no view')
    return shown.view
  }
  return { core, garage, sessions, handle, create, session, tool, panel }
}

const note = (over: Partial<Note>): Note => ({
  key: 'global:a.md',
  name: 'A',
  description: '',
  scope: 'global',
  file: 'a.md',
  path: '/g/a.md',
  on: true,
  ...over,
})

it('reads and writes front matter, and names files from the note name', () => {
  expect(slugOf('How to run the tests!')).toBe('how-to-run-the-tests')
  const text = noteText('Tests', 'When: running\nthe suite', '\nRun npm test\n\n')
  expect(text).toBe('---\nname: Tests\ndescription: When: running the suite\n---\n\nRun npm test\n')
  expect(parseNote(text, 'tests.md')).toEqual({ name: 'Tests', description: 'When: running the suite', body: '\nRun npm test\n' })
  expect(parseNote('Just text', 'plain.md')).toEqual({ name: 'plain', description: '', body: 'Just text' })
})

it('lists notes that are on by name, description and path, never their bodies', () => {
  const index = noteIndex(
    [
      note({ name: 'Deploys', description: 'How to ship', path: '/g/deploys.md' }),
      note({ key: 's:t.md', name: 'Tests', scope: 'space', spaceId: 's', path: '/c/s/notes/t.md' }),
      note({ key: 'global:x.md', name: 'Hidden', on: false }),
    ],
    true,
  )!
  expect(index).toContain('- Deploys (global): How to ship. /g/deploys.md')
  expect(index).toContain('- Tests (space). /c/s/notes/t.md')
  expect(index).toContain('read_note')
  expect(index).not.toContain('Hidden')
  expect(noteIndex([], true)).toContain('none saved yet')
  // Without the Kothar MCP server there are no tools to mention, and nothing to say about no notes.
  expect(noteIndex([], false)).toBeUndefined()
  expect(noteIndex([note({})], false)).not.toContain('read_note')
})

it('gives each chat the global notes and its own space’s, workers their space’s, and Home only global ones', async () => {
  const { garage, create, session, tool, sessions } = await start()
  const app = create('App')
  const other = create('Other')
  expect(session(app).instructions).toContain('Notes: none saved yet')

  const saved = await tool(app, 'write_note', { name: 'Run the tests', description: 'Before a PR', body: 'npm test' })
  expect(saved.isError).toBe(false)
  const file = join(garage, 'chats', app, 'notes', 'run-the-tests.md')
  expect(readFileSync(file, 'utf8')).toBe('---\nname: Run the tests\ndescription: Before a PR\n---\n\nnpm test\n')
  expect(JSON.parse(saved.text)).toMatchObject({ saved: { name: 'Run the tests', scope: 'space', path: file }, replaced: false })

  expect(await tool('main', 'write_note', { name: 'Style', description: 'Prose', body: 'Short words', scope: 'space' })).toMatchObject({
    isError: true,
  })
  expect((await tool('main', 'write_note', { name: 'Style', description: 'Prose', body: 'Short words' })).isError).toBe(false)
  const global = join(garage, 'extensions', 'notes', 'style.md')
  expect(existsSync(global)).toBe(true)

  const appView = session(app).instructions
  expect(appView).toContain(`- Run the tests (space): Before a PR. ${file}`)
  expect(appView).toContain(`- Style (global): Prose. ${global}`)
  expect(appView).not.toContain('npm test')
  const otherView = session(other).instructions
  expect(otherView).toContain('Style')
  expect(otherView).not.toContain('Run the tests')
  expect(session('main').instructions).not.toContain('Run the tests')

  // Same name in the same scope replaces it.
  const again = await tool(app, 'write_note', { name: 'run the tests', description: 'Before a PR', body: 'npm run test' })
  expect(JSON.parse(again.text).replaced).toBe(true)

  // A worker sees its space's notes, and saves into its space.
  const spawned = await tool(app, 'spawn_worker', { task: 'Look' })
  expect(spawned.isError).toBe(false)
  await until(() => sessions.at(-1)!.prompt === 'Look')
  const worker = JSON.parse(spawned.text).chatId as string
  expect(sessions.at(-1)!.options.instructions).toContain('run the tests (space)')
  expect((await tool(worker, 'write_note', { name: 'Found', description: 'x', body: 'y' })).isError).toBe(false)
  expect(existsSync(join(garage, 'chats', app, 'notes', 'found.md'))).toBe(true)

  const read = await tool(other, 'read_note', { name: 'style' })
  expect(read.text).toContain('Short words')
  expect((await tool(other, 'read_note', { name: 'Run the tests' })).isError).toBe(true)
})

it('switches a note off for a chat and the workers below it, from the panel', async () => {
  const { garage, create, session, tool, panel, sessions } = await start()
  const app = create('App')
  mkdirSync(join(garage, 'extensions', 'notes'), { recursive: true })
  writeFileSync(join(garage, 'extensions', 'notes', 'style.md'), noteText('Style', 'Prose', 'Short'))
  await panel(app, { name: 'toggle', value: 'global:style.md' })
  expect(session(app).instructions).not.toContain('Style')
  expect(session('main').instructions).toContain('Style')
  const listed = JSON.parse((await tool(app, 'list_notes')).text)
  expect(listed).toEqual([expect.objectContaining({ name: 'Style', on: false })])
  const spawned = await tool(app, 'spawn_worker', { task: 'Look' })
  await until(() => sessions.at(-1)!.prompt === 'Look')
  expect(sessions.at(-1)!.options.instructions).not.toContain('Style')
  const worker = JSON.parse(spawned.text).chatId as string
  // A worker's panel is read-only.
  expect(JSON.stringify(await panel(worker))).not.toContain('"Edit"')
  await panel(app, { name: 'toggle', value: 'global:style.md' })
  expect(session(app).instructions).toContain('Style')
  expect(existsSync(join(garage, 'chats', app, 'notes-off.json'))).toBe(false)
})

it('makes, edits, renames and deletes notes from the panel', async () => {
  const { garage, create, panel } = await start()
  const app = create('App')
  const form = await panel(app, { name: 'new', value: 'space' })
  expect(JSON.stringify(form)).toContain('"type":"form"')
  await panel(app, { name: 'save', value: { name: 'Deploys', description: 'Shipping', body: '# Ship\n' } })
  const first = join(garage, 'chats', app, 'notes', 'deploys.md')
  expect(readFileSync(first, 'utf8')).toContain('# Ship')

  const editing = JSON.stringify(await panel(app, { name: 'edit', value: `${app}:deploys.md` }))
  expect(editing).toContain('"value":"Deploys"')
  const list = await panel(app, { name: 'save', value: { name: 'Releases', description: 'Shipping', body: '# Ship\n' } })
  expect(existsSync(first)).toBe(false)
  expect(existsSync(join(garage, 'chats', app, 'notes', 'releases.md'))).toBe(true)
  expect(JSON.stringify(list)).toContain('"title":"Releases"')

  await panel(app, { name: 'new', value: 'global' })
  await panel(app, { name: 'save', value: { name: 'Everywhere', description: '', body: 'hi' } })
  expect(existsSync(join(garage, 'extensions', 'notes', 'everywhere.md'))).toBe(true)

  await panel(app, { name: 'delete', value: `${app}:releases.md` })
  expect(existsSync(join(garage, 'chats', app, 'notes', 'releases.md'))).toBe(false)
  // Home has no notes of its own: only global ones.
  expect(JSON.stringify(await panel('main'))).not.toContain('This space')
})
