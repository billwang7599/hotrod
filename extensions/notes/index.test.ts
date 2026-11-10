import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ExtensionView } from '@kothar/extension-api'
import { startCore } from '@kothar/core/main'
import type { Adapter, ClientMessage, CoreMessage, SessionOptions } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import home from '../home/index.ts'
import { createNotesExtension, freeName, noteText, noteToDelete, noteWatcher, parseNote, searchNotes, slugOf, type Note } from './index.ts'

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
  return { core, garage, sessions, handle, create, session, tool, panel, views, messages }
}

const note = (over: Partial<Note>): Note => ({
  key: 'global:a.md',
  name: 'A',
  description: '',
  scope: 'global',
  file: 'a.md',
  path: '/g/a.md',
  ...over,
})

it('reads and writes front matter, and names files from the note name', () => {
  expect(slugOf('How to run the tests!')).toBe('how-to-run-the-tests')
  const text = noteText('Tests', 'When: running\nthe suite', '\nRun npm test\n\n')
  expect(text).toBe('---\nname: Tests\ndescription: When: running the suite\n---\n\nRun npm test\n')
  expect(parseNote(text, 'tests.md')).toEqual({ name: 'Tests', description: 'When: running the suite', body: 'Run npm test\n' })
  expect(parseNote('Just text', 'plain.md')).toEqual({ name: 'plain', description: '', body: 'Just text' })
  // What the editor sends comes back byte for byte, blank lines and all.
  for (const body of ['', '\n\nlead', 'trail\n\n\n', '  spaced  ']) {
    expect(parseNote(noteText('N', '', body, true), 'n.md').body).toBe(body)
  }
})

it('names a new note Untitled, then Untitled 2, within its scope', () => {
  expect(freeName([], 'space')).toBe('Untitled')
  const taken = [note({ key: 's:untitled.md', file: 'untitled.md', scope: 'space' }), note({ key: 'global:untitled-2.md', file: 'untitled-2.md' })]
  expect(freeName(taken, 'space')).toBe('Untitled 2')
  expect(freeName(taken, 'global')).toBe('Untitled')
})

it('searches names and descriptions first, then text, for every word', () => {
  const notes = [note({ key: 'a', name: 'Deploys', description: 'Shipping' }), note({ key: 'b', name: 'Tests' }), note({ key: 'c', name: 'Style' })]
  const bodies: Record<string, string> = { a: 'friday', b: 'how we ship: npm test', c: 'short words' }
  const found = (q: string) => searchNotes(notes, q, (n) => bodies[n.key]!).map((n) => n.name)
  expect(found('ship')).toEqual(['Deploys', 'Tests'])
  expect(found('SHIP npm')).toEqual(['Tests'])
  expect(found('  ')).toEqual(['Deploys', 'Tests', 'Style'])
  expect(found('nothing')).toEqual([])
})

it('puts no notes in any prompt: agents reach the global notes and their space’s with tools only', async () => {
  const { garage, create, session, tool, sessions } = await start()
  const app = create('App')
  const other = create('Other')
  // The old index started "Notes:" and told agents about the note tools.
  expect(session(app).instructions).not.toContain('Notes:')
  expect(session(app).instructions).not.toContain('write_note')

  const saved = await tool(app, 'write_note', { name: 'Run the tests', description: 'Before a PR', body: 'npm test' })
  expect(saved.isError).toBe(false)
  const file = join(garage, 'chats', app, 'notes', 'run-the-tests.md')
  expect(readFileSync(file, 'utf8')).toBe('---\nname: Run the tests\ndescription: Before a PR\n---\n\nnpm test\n')
  expect(JSON.parse(saved.text)).toMatchObject({ saved: { name: 'Run the tests', scope: 'space', path: file }, replaced: false })

  expect(await tool('main', 'write_note', { name: 'Style', body: 'Short words', scope: 'space' })).toMatchObject({ isError: true })
  expect((await tool('main', 'write_note', { name: 'Style', description: 'Prose', body: 'Short words' })).isError).toBe(false)
  const global = join(garage, 'extensions', 'notes', 'style.md')
  expect(existsSync(global)).toBe(true)

  // Saved notes still stay out of every prompt.
  for (const chat of [app, other, 'main']) {
    const { instructions } = session(chat)
    expect(instructions).not.toContain('Run the tests')
    expect(instructions).not.toContain('Style')
  }
  expect(JSON.parse((await tool(app, 'list_notes')).text).map((n: Note) => n.name)).toEqual(['Style', 'Run the tests'])
  expect(JSON.parse((await tool(other, 'list_notes')).text).map((n: Note) => n.name)).toEqual(['Style'])

  // Same name in the same scope replaces it.
  const again = await tool(app, 'write_note', { name: 'run the tests', description: 'Before a PR', body: 'npm run test' })
  expect(JSON.parse(again.text).replaced).toBe(true)

  // A worker reaches its space's notes, and saves into its space.
  const spawned = await tool(app, 'spawn_worker', { task: 'Look' })
  expect(spawned.isError).toBe(false)
  await until(() => sessions.at(-1)!.prompt === 'Look')
  const worker = JSON.parse(spawned.text).chatId as string
  expect(sessions.at(-1)!.options.instructions).not.toContain('run the tests')
  expect((await tool(worker, 'write_note', { name: 'Found', description: 'x', body: 'y' })).isError).toBe(false)
  expect(existsSync(join(garage, 'chats', app, 'notes', 'found.md'))).toBe(true)

  const read = await tool(other, 'read_note', { name: 'style' })
  expect(read.text).toContain('Short words')
  expect((await tool(other, 'read_note', { name: 'Run the tests' })).isError).toBe(true)
})

it('searches notes for an agent, with the matching lines', async () => {
  const { create, tool } = await start()
  const app = create('App')
  await tool(app, 'write_note', { name: 'Deploys', description: 'Shipping', body: '# Deploys\nShip on Fridays\nNever on Mondays' })
  await tool(app, 'write_note', { name: 'Style', body: 'Short words', scope: 'global' })
  const hits = JSON.parse((await tool(app, 'search_notes', { query: 'fridays' })).text)
  expect(hits).toEqual([expect.objectContaining({ name: 'Deploys', scope: 'space', lines: ['Ship on Fridays'] })])
  expect(JSON.parse((await tool(app, 'search_notes', { query: 'nope' })).text)).toEqual([])
})

it('opens as a popup with a sidebar entry and keys, not a tab, in every chat', async () => {
  const { create, handle, messages } = await start()
  const app = create('App')
  handle({ type: 'context.get', chatId: app })
  const shown = messages.findLast((m) => m.type === 'chat.extensions' && m.chatId === app)
  expect(shown?.type === 'chat.extensions' && shown.panels).toContainEqual({
    extension: 'notes',
    id: 'notes',
    title: 'Notes',
    placement: 'popup',
    shortcut: 'Mod+Shift+N',
    sidebar: true,
  })
})

it('makes, writes, renames and deletes notes from the popup', async () => {
  const { garage, create, panel } = await start()
  const app = create('App')
  const dir = join(garage, 'chats', app, 'notes')
  const made = JSON.stringify(await panel(app, { name: 'new', value: 'space' }))
  expect(readFileSync(join(dir, 'untitled.md'), 'utf8')).toBe('---\nname: Untitled\ndescription: \n---\n\n')
  expect(made).toContain('"type":"editor"')
  expect(made).toContain('"key":"rename:')

  // The editor's text is kept exactly as typed.
  await panel(app, { name: 'write', value: '# Ship\n\n' })
  expect(readFileSync(join(dir, 'untitled.md'), 'utf8')).toBe('---\nname: Untitled\ndescription: \n---\n\n# Ship\n\n')

  const renamed = JSON.stringify(await panel(app, { name: 'renamed', value: { name: 'Releases', description: 'Shipping' } }))
  expect(existsSync(join(dir, 'untitled.md'))).toBe(false)
  expect(readFileSync(join(dir, 'releases.md'), 'utf8')).toContain('description: Shipping\n---\n\n# Ship\n\n')
  expect(renamed).toContain(`"key":"${app}:releases.md"`)
  expect(renamed).not.toContain('"key":"rename:')

  await panel(app, { name: 'new', value: 'global' })
  expect(existsSync(join(garage, 'extensions', 'notes', 'untitled.md'))).toBe(true)

  const deleted = JSON.stringify(await panel(app, { name: 'delete', value: `${app}:releases.md` }))
  expect(existsSync(join(dir, 'releases.md'))).toBe(false)
  expect(deleted).not.toContain('Releases')
  // Home has no notes of its own: only global ones.
  const home = JSON.stringify(await panel('main'))
  expect(home).not.toContain('This space')
  expect(home).toContain('"label":"Untitled"')
})

it('lists notes by search, and opens one in the editor', async () => {
  const { create, tool, panel } = await start()
  const app = create('App')
  await tool(app, 'write_note', { name: 'Deploys', body: 'Ship on Fridays' })
  await tool(app, 'write_note', { name: 'Style', body: 'Short words', scope: 'global' })
  const all = JSON.stringify(await panel(app))
  expect(all).toContain('"label":"Deploys"')
  expect(all).toContain('"label":"Style"')
  expect(all).toContain('Pick a note')
  const found = JSON.stringify(await panel(app, { name: 'search', value: 'friday' }))
  expect(found).toContain('"label":"Deploys"')
  expect(found).not.toContain('"label":"Style"')
  expect(found).toContain('Nothing matches')
  const opened = JSON.stringify(await panel(app, { name: 'open', value: `${app}:deploys.md` }))
  expect(opened).toContain('"type":"editor"')
  expect(opened).toContain('"text":"Ship on Fridays\\n"')
  expect(opened).toContain('"selected":true')
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

  // From the popup: renaming a note to the clashing name keeps the form open with the reason, and writes nothing.
  await panel(app, { name: 'new', value: 'space' })
  await panel(app, { name: 'write', value: 'ctest' })
  const refused = JSON.stringify(await panel(app, { name: 'renamed', value: { name: 'C++ tests', description: '' } }))
  expect(refused).toContain('"type":"form"')
  expect(refused).toContain('share the file c-tests.md with the note \\"C tests\\"')
  expect(readFileSync(join(dir, 'c-tests.md'), 'utf8')).toContain('make test')
  // Renaming to an existing note's exact name is refused too, rather than replacing it; both notes stay.
  const same = JSON.stringify(await panel(app, { name: 'renamed', value: { name: 'C tests', description: '' } }))
  expect(same).toContain('A note named \\"C tests\\" already exists in this space')
  expect(readFileSync(join(dir, 'c-tests.md'), 'utf8')).toContain('make test')
  expect(readFileSync(join(dir, 'untitled.md'), 'utf8')).toContain('ctest')
  await panel(app, { name: 'cancel' })

  // Renaming to its own name in other letter case still renames it.
  await panel(app, { name: 'rename' })
  const kept = JSON.stringify(await panel(app, { name: 'renamed', value: { name: 'UNTITLED', description: '' } }))
  expect(kept).not.toContain('"type":"form"')
  expect(readFileSync(join(dir, 'untitled.md'), 'utf8')).toContain('name: UNTITLED')
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

it('shows notes changed outside Kothar in an open popup', async () => {
  const { garage, create, panel, views } = await start()
  const app = create('App')
  const shows = (text: string) => views(app).some((m) => m.type === 'extension.panel' && JSON.stringify(m.view).includes(text))
  // The space has no notes folder yet: it's waited for.
  expect(JSON.stringify(await panel(app))).toContain('No notes here yet')
  const dir = join(garage, 'chats', app, 'notes')
  mkdirSync(dir)
  writeFileSync(join(dir, 'deploys.md'), noteText('Deploys', 'Shipping', 'ship'))
  await until(() => shows('"label":"Deploys"'))

  await panel(app, { name: 'open', value: `${app}:deploys.md` })
  writeFileSync(join(dir, 'deploys.md'), noteText('Deploys', 'Shipping', 'ship on Fridays'))
  await until(() => shows('ship on Fridays'))

  const global = join(garage, 'extensions', 'notes')
  mkdirSync(global, { recursive: true })
  writeFileSync(join(global, 'style.md'), noteText('Style', '', 'short'))
  await until(() => shows('"label":"Style"'))

  rmSync(join(dir, 'deploys.md'))
  await until(() => {
    const last = views(app).at(-1)
    return last?.type === 'extension.panel' && !JSON.stringify(last.view).includes('"label":"Deploys"')
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
