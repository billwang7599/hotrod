import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ExtensionView } from '@kothar/extension-api'
import { startCore } from '@kothar/core/main'
import type { Adapter, ClientMessage, CoreMessage, SessionOptions } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import home from '../home/index.ts'
import { createNotesExtension, noteIndex, noteText, noteToDelete, noteWatcher, parseNote, slugOf, type Note } from './index.ts'

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
    extensions: [home, createNotesExtension({ pollMs: 50 })],
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
  return { core, garage, sessions, handle, create, session, tool, panel, views }
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

it('never lets one note overwrite another whose name makes the same file', async () => {
  const { garage, create, tool, panel } = await start()
  const app = create('App')
  const dir = join(garage, 'chats', app, 'notes')
  expect((await tool(app, 'write_note', { name: 'C tests', description: 'C', body: 'make test' })).isError).toBe(false)

  // "C++ tests" makes c-tests.md too: refused, and the C note is untouched.
  const clash = await tool(app, 'write_note', { name: 'C++ tests', description: 'C++', body: 'ctest' })
  expect(clash).toMatchObject({ isError: true })
  expect(clash.text).toContain('"C tests"')
  expect(readFileSync(join(dir, 'c-tests.md'), 'utf8')).toContain('make test')

  // From the panel: a new note with the clashing name stays in the form with the reason, and nothing is written.
  await panel(app, { name: 'new', value: 'space' })
  const refused = JSON.stringify(await panel(app, { name: 'save', value: { name: 'C++ tests', description: '', body: 'ctest' } }))
  expect(refused).toContain('"type":"form"')
  expect(refused).toContain('share the file c-tests.md with the note \\"C tests\\"')
  expect(readFileSync(join(dir, 'c-tests.md'), 'utf8')).toContain('make test')
  // A new note with an existing note's exact name is refused in the panel too, rather than replacing it.
  const same = JSON.stringify(await panel(app, { name: 'save', value: { name: 'C tests', description: '', body: 'other' } }))
  expect(same).toContain('A note named \\"C tests\\" already exists in this space')
  expect(readFileSync(join(dir, 'c-tests.md'), 'utf8')).toContain('make test')
  await panel(app, { name: 'cancel' })

  // Renaming a note to another note's name keeps both.
  await panel(app, { name: 'new', value: 'space' })
  await panel(app, { name: 'save', value: { name: 'Deploys', description: '', body: 'ship' } })
  await panel(app, { name: 'edit', value: `${app}:deploys.md` })
  const renamed = JSON.stringify(await panel(app, { name: 'save', value: { name: 'C tests', description: '', body: 'ship' } }))
  expect(renamed).toContain('already exists')
  expect(readFileSync(join(dir, 'c-tests.md'), 'utf8')).toContain('make test')
  expect(readFileSync(join(dir, 'deploys.md'), 'utf8')).toContain('ship')
  // Saving under its own name, in other letter case, still edits it.
  const kept = JSON.stringify(await panel(app, { name: 'save', value: { name: 'DEPLOYS', description: '', body: 'ship it' } }))
  expect(kept).not.toContain('"type":"form"')
  expect(readFileSync(join(dir, 'deploys.md'), 'utf8')).toContain('ship it')
})

it('deletes a note by name, from the caller’s space or global notes, asking which when both have the name', async () => {
  const { garage, create, tool, sessions } = await start()
  const app = create('App')
  const other = create('Other')
  const spaceDir = join(garage, 'chats', app, 'notes')
  const globalDir = join(garage, 'extensions', 'notes')
  await tool(app, 'write_note', { name: 'Tests', description: 'x', body: 'space' })
  await tool(app, 'write_note', { name: 'Tests', description: 'x', body: 'global', scope: 'global' })
  await tool(app, 'write_note', { name: 'Deploys', description: 'x', body: 'ship' })

  const both = await tool(app, 'delete_note', { name: 'Tests' })
  expect(both).toMatchObject({ isError: true })
  expect(both.text).toContain('say which with scope')
  expect(existsSync(join(spaceDir, 'tests.md'))).toBe(true)
  expect(existsSync(join(globalDir, 'tests.md'))).toBe(true)

  const gone = await tool(app, 'delete_note', { name: 'tests', scope: 'space' })
  expect(gone.isError).toBe(false)
  expect(JSON.parse(gone.text)).toMatchObject({ deleted: { name: 'Tests', scope: 'space' } })
  expect(existsSync(join(spaceDir, 'tests.md'))).toBe(false)
  expect(existsSync(join(globalDir, 'tests.md'))).toBe(true)

  // Another space can't reach this space's notes.
  expect(await tool(other, 'delete_note', { name: 'Deploys' })).toMatchObject({ isError: true })
  expect(existsSync(join(spaceDir, 'deploys.md'))).toBe(true)

  // A worker deletes from its space; Home reaches global notes only.
  const spawned = await tool(app, 'spawn_worker', { task: 'Look' })
  await until(() => sessions.at(-1)!.prompt === 'Look')
  const worker = JSON.parse(spawned.text).chatId as string
  expect((await tool(worker, 'delete_note', { name: 'Deploys' })).isError).toBe(false)
  expect(existsSync(join(spaceDir, 'deploys.md'))).toBe(false)
  expect(await tool('main', 'delete_note', { name: 'Tests', scope: 'space' })).toMatchObject({ isError: true })
  expect((await tool('main', 'delete_note', { name: 'Tests' })).isError).toBe(false)
  expect(existsSync(join(globalDir, 'tests.md'))).toBe(false)
})

it('picks the note to delete by exact name only, naming the closest note otherwise', () => {
  const notes = [
    note({ key: 'global:c-tests.md', name: 'C tests', file: 'c-tests.md' }),
    note({ key: 's:deploys.md', name: 'Deploys', scope: 'space', spaceId: 's', file: 'deploys.md' }),
  ]
  expect(noteToDelete(notes, 'c tests').name).toBe('C tests')
  expect(noteToDelete(notes, 'deploys', 'space').name).toBe('Deploys')
  // "C++ tests" shares c-tests.md with "C tests", but isn't its name: refused, and the error names it.
  expect(() => noteToDelete(notes, 'C++ tests')).toThrow('No note named "C++ tests"; the closest is "C tests" (global)')
  expect(() => noteToDelete(notes, 'deploys', 'global')).toThrow(
    'No note named "deploys" in global notes; the closest is "Deploys" (space)',
  )
  expect(() => noteToDelete(notes, 'Release')).toThrow('No note named "Release"; list_notes lists them')

  // A global and a space note sharing a file but not a name: neither is picked for a third name with that file.
  const shared = [
    note({ key: 'global:c-tests.md', name: 'C tests', file: 'c-tests.md' }),
    note({ key: 's:c-tests.md', name: 'C# tests', scope: 'space', spaceId: 's', file: 'c-tests.md' }),
  ]
  expect(() => noteToDelete(shared, 'C++ tests')).toThrow('No note named "C++ tests"')
  expect(noteToDelete(shared, 'C# tests').scope).toBe('space')
  expect(noteToDelete(shared, 'c tests').scope).toBe('global')
})

it('never deletes a note whose name only shares the file of the name asked for', async () => {
  const { garage, create, tool } = await start()
  const app = create('App')
  const spaceDir = join(garage, 'chats', app, 'notes')
  const globalDir = join(garage, 'extensions', 'notes')
  await tool(app, 'write_note', { name: 'C++ tests', description: 'x', body: 'global', scope: 'global' })
  await tool(app, 'write_note', { name: 'C# tests', description: 'x', body: 'space' })

  const refused = await tool(app, 'delete_note', { name: 'C tests' })
  expect(refused).toMatchObject({ isError: true })
  expect(refused.text).toContain('No note named "C tests"; the closest is "C++ tests" (global)')
  expect(existsSync(join(globalDir, 'c-tests.md'))).toBe(true)
  expect(existsSync(join(spaceDir, 'c-tests.md'))).toBe(true)

  // The exact name still deletes, from the scope that has it.
  expect((await tool(app, 'delete_note', { name: 'c# tests' })).isError).toBe(false)
  expect(existsSync(join(spaceDir, 'c-tests.md'))).toBe(false)
  expect(existsSync(join(globalDir, 'c-tests.md'))).toBe(true)
})

it('shows notes changed outside Kothar in an open Notes tab', async () => {
  const { garage, create, panel, views } = await start()
  const app = create('App')
  const shows = (text: string) => views(app).some((m) => m.type === 'extension.panel' && JSON.stringify(m.view).includes(text))
  // The space has no notes folder yet: it's waited for.
  expect(JSON.stringify(await panel(app))).toContain('No notes for this space yet')
  const dir = join(garage, 'chats', app, 'notes')
  mkdirSync(dir)
  writeFileSync(join(dir, 'deploys.md'), noteText('Deploys', 'Shipping', 'ship'))
  await until(() => shows('"title":"Deploys"'))

  writeFileSync(join(dir, 'deploys.md'), noteText('Deploys', 'Shipping', 'ship on Fridays'))
  await until(() => shows('ship on Fridays'))

  const global = join(garage, 'extensions', 'notes')
  mkdirSync(global, { recursive: true })
  writeFileSync(join(global, 'style.md'), noteText('Style', '', 'short'))
  await until(() => shows('"title":"Style"'))

  rmSync(join(dir, 'deploys.md'))
  await until(() => {
    const last = views(app).at(-1)
    return last?.type === 'extension.panel' && !JSON.stringify(last.view).includes('"title":"Deploys"')
  })
})

it('stops watching a space’s notes when told to forget it, and everything on close', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-notes-watch-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const seen: string[] = []
  const watcher = noteWatcher((owner) => seen.push(owner), 20)
  cleanups.push(() => watcher.closeAll())
  mkdirSync(join(dir, 'a'))
  watcher.add(join(dir, 'a'), 'a')
  watcher.add(join(dir, 'b'), 'b')
  writeFileSync(join(dir, 'a', 'x.md'), 'x')
  await until(() => seen.includes('a'))
  // A folder that didn't exist is watched for notes appearing in it.
  mkdirSync(join(dir, 'b'))
  writeFileSync(join(dir, 'b', 'x.md'), 'x')
  await until(() => seen.includes('b'))
  watcher.forget('a')
  seen.length = 0
  writeFileSync(join(dir, 'a', 'y.md'), 'y')
  writeFileSync(join(dir, 'b', 'y.md'), 'y')
  await until(() => seen.includes('b'))
  await new Promise((r) => setTimeout(r, 100))
  expect(seen).not.toContain('a')
})
