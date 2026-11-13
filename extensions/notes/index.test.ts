import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ExtensionView } from '@kothar/extension-api'
import { startCore } from '@kothar/core/main'
import type { Adapter, ClientMessage, CoreMessage, SessionOptions } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import home from '../home/index.ts'
import {
  backlinksOf,
  createNotesExtension,
  attachmentsIn,
  freeName,
  frontMatterTags,
  fuzzyMatches,
  fuzzyRanges,
  headingsIn,
  linkMention,
  wordRanges,
  linksIn,
  mentionsOf,
  linkTarget,
  noteText,
  relink,
  resolveLink,
  shortTime,
  snippetOf,
  tagsIn,
  titleFrom,
  noteToDelete,
  noteWatcher,
  PASTED_PICTURE,
  parseNote,
  searchNotes,
  slugOf,
  wordCount,
  type Note,
} from './index.ts'
import { until as waitUntil } from '@kothar/core/test-wait'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const until = (check: () => boolean) => waitUntil(check, { tries: 600 })

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
  expect(parseNote('Just text', 'plain.md')).toEqual({ name: 'plain', description: '', body: 'Just text', frontMatter: false })
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
    launcher: true,
  })
})

it('makes, writes, renames and deletes notes from the popup', async () => {
  const { garage, create, panel } = await start()
  const app = create('App')
  const dir = join(garage, 'chats', app, 'notes')
  const made = JSON.stringify(await panel(app, { name: 'new', value: 'space' }))
  expect(readFileSync(join(dir, 'untitled.md'), 'utf8')).toBe('---\nname: Untitled\ndescription: \n---\n\n')
  expect(made).toContain('"type":"editor"')
  // A new note goes straight to the editor, with no form to fill in first.
  expect(made).not.toContain('"key":"rename:')
  expect(made).toContain('"autofocus":true')

  // The editor's text is kept exactly as typed, and an Untitled note takes its first line as its name, keeping its
  // editor (same key) so the cursor stays.
  const named = JSON.stringify(await panel(app, { name: 'write', value: '# Ship it\n\n' }))
  expect(existsSync(join(dir, 'untitled.md'))).toBe(false)
  expect(readFileSync(join(dir, 'ship-it.md'), 'utf8')).toBe('---\nname: Ship it\ndescription: \n---\n\n# Ship it\n\n')
  expect(named).toContain(`"key":"${app}:untitled.md","text"`)
  expect(named).toContain('"label":"Ship it"')

  const renamed = JSON.stringify(await panel(app, { name: 'renamed', value: { name: 'Releases', description: 'Shipping' } }))
  expect(existsSync(join(dir, 'ship-it.md'))).toBe(false)
  expect(readFileSync(join(dir, 'releases.md'), 'utf8')).toContain('description: Shipping\n---\n\n# Ship it\n\n')
  expect(renamed).toContain(`"key":"${app}:releases.md"`)
  expect(renamed).not.toContain('"key":"rename:')
  // Once renamed by hand, its first line no longer names it.
  await panel(app, { name: 'write', value: '# Other\n' })
  expect(existsSync(join(dir, 'releases.md'))).toBe(true)

  await panel(app, { name: 'new', value: 'global' })
  expect(existsSync(join(garage, 'extensions', 'notes', 'untitled.md'))).toBe(true)

  const deleted = JSON.stringify(await panel(app, { name: 'delete', value: `${app}:releases.md` }))
  expect(existsSync(join(dir, 'releases.md'))).toBe(false)
  expect(deleted).not.toContain('"label":"Releases"')
  expect(deleted).toContain('Deleted “Releases”')
  // Undo brings it back, as it was, and opens it.
  const back = JSON.stringify(await panel(app, { name: 'undo' }))
  expect(readFileSync(join(dir, 'releases.md'), 'utf8')).toContain('# Other\n')
  expect(back).toContain(`"key":"${app}:releases.md","label":"Releases","selected":true`)
  expect(back).not.toContain('Deleted “')
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
  // The first look opens the note edited last, without taking the keyboard.
  expect(all).toContain('"key":"global:style.md","label":"Style","selected":true')
  expect(all).toContain('"autofocus":false')
  await panel(app, { name: 'open', value: `${app}:deploys.md` })
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
  expect(readFileSync(join(dir, 'ctest.md'), 'utf8')).toContain('name: ctest')
  const refused = JSON.stringify(await panel(app, { name: 'renamed', value: { name: 'C++ tests', description: '' } }))
  expect(refused).toContain('"type":"form"')
  expect(refused).toContain('share the file c-tests.md with the note \\"C tests\\"')
  expect(readFileSync(join(dir, 'c-tests.md'), 'utf8')).toContain('make test')
  // Renaming to an existing note's exact name is refused too, rather than replacing it; both notes stay.
  const same = JSON.stringify(await panel(app, { name: 'renamed', value: { name: 'C tests', description: '' } }))
  expect(same).toContain('A note named \\"C tests\\" already exists in this space')
  expect(readFileSync(join(dir, 'c-tests.md'), 'utf8')).toContain('make test')
  expect(readFileSync(join(dir, 'ctest.md'), 'utf8')).toContain('ctest')
  await panel(app, { name: 'cancel' })

  // Renaming to its own name in other letter case still renames it.
  await panel(app, { name: 'rename' })
  const kept = JSON.stringify(await panel(app, { name: 'renamed', value: { name: 'CTEST', description: '' } }))
  expect(kept).not.toContain('"type":"form"')
  expect(readFileSync(join(dir, 'ctest.md'), 'utf8')).toContain('name: CTEST')
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

it('reads [[links]] and #tags from a note, never from code', () => {
  expect(linkTarget('Deploys|ship notes')).toBe('Deploys')
  expect(linkTarget('Deploys#Fridays')).toBe('Deploys')
  const text = '# Heading\nSee [[Deploys|ship]], [[Style]] and [[Deploys#x]]. #todo #12 a#b (#idea) #area/sub\n`[[Not]] #not`\n```\n[[Code]] #code\n```\n'
  expect(linksIn(text)).toEqual(['Deploys', 'Style'])
  expect(tagsIn(text)).toEqual(['todo', 'idea', 'area/sub'])
})

it("resolves a link to this space's note first, by name or file, and finds the notes that link to one", () => {
  const notes = [
    note({ key: 'global:deploys.md', name: 'Deploys', file: 'deploys.md' }),
    note({ key: 's:deploys.md', name: 'Deploys', scope: 'space', spaceId: 's', file: 'deploys.md' }),
    note({ key: 'global:style-guide.md', name: 'Style guide', file: 'style-guide.md' }),
    note({ key: 's:index.md', name: 'Index', scope: 'space', spaceId: 's', file: 'index.md' }),
  ]
  expect(resolveLink(notes, 'deploys')?.key).toBe('s:deploys.md')
  expect(resolveLink(notes, 'style-guide')?.key).toBe('global:style-guide.md')
  expect(resolveLink(notes, 'Style Guide')?.key).toBe('global:style-guide.md')
  expect(resolveLink(notes, 'Nope')).toBeUndefined()
  const bodies: Record<string, string> = { 's:index.md': '[[Deploys]] and [[Style guide]]', 'global:deploys.md': '[[Style guide]]' }
  const linking = (key: string) => backlinksOf(notes, notes.find((n) => n.key === key)!, (n) => bodies[n.key] ?? '').map((n) => n.key)
  expect(linking('s:deploys.md')).toEqual(['s:index.md'])
  expect(linking('global:style-guide.md')).toEqual(['global:deploys.md', 's:index.md'])
  expect(linking('global:deploys.md')).toEqual([])
})

it('follows a [[link]] from the editor, making the note if there is none, and lists backlinks', async () => {
  const { garage, create, tool, panel } = await start()
  const app = create('App')
  await tool(app, 'write_note', { name: 'Index', body: 'See [[Deploys]] and [[Style|style]]' })
  await tool(app, 'write_note', { name: 'Style', body: 'Short words', scope: 'global' })
  await panel(app, { name: 'open', value: `${app}:index.md` })
  // An existing note opens, and lists Index as linking to it.
  const style = JSON.stringify(await panel(app, { name: 'link', value: 'Style' }))
  expect(style).toContain('"text":"Short words\\n"')
  expect(style).toMatch(/"label":"Linked from".*"label":"Index"/)
  // A missing one is made in this space, empty, and opened.
  const made = JSON.stringify(await panel(app, { name: 'link', value: 'Deploys' }))
  expect(readFileSync(join(garage, 'chats', app, 'notes', 'deploys.md'), 'utf8')).toBe('---\nname: Deploys\ndescription: \n---\n\n')
  expect(made).toContain(`"key":"${app}:deploys.md"`)
  expect(made).toMatch(/"label":"Linked from".*"label":"Index"/)
  // The editor sends links and tags back as actions.
  expect(made).toContain('"links":"link"')
  expect(made).toContain('"tags":"tag"')
  // Home makes a missing note global.
  await panel('main', { name: 'link', value: 'Inbox' })
  expect(existsSync(join(garage, 'extensions', 'notes', 'inbox.md'))).toBe(true)
})

it('filters the list by tag, from the tag row or a #tag clicked in the editor', async () => {
  const { create, tool, panel } = await start()
  const app = create('App')
  await tool(app, 'write_note', { name: 'Deploys', body: 'Ship #ops #todo' })
  await tool(app, 'write_note', { name: 'Style', body: 'Short #writing', scope: 'global' })
  const all = JSON.stringify(await panel(app))
  // Each tag is just its name; how many notes have it shows on hover.
  for (const tag of ['#ops', '#todo', '#writing']) expect(all).toContain(`"label":"${tag}"`)
  expect(all).toContain('"label":"#ops","variant":"ghost","action":{"name":"tag","value":"ops"},"hint":"1 note"')
  await panel(app, { name: 'open', value: `${app}:deploys.md` })
  const ops = JSON.stringify(await panel(app, { name: 'tag', value: 'ops' }))
  expect(ops).toContain('"label":"Deploys"')
  expect(ops).not.toContain('"label":"Style"')
  expect(ops).toMatch(/"label":"#ops","variant":"primary"/)
  // Clicking the tag again (an empty value) clears it.
  expect(JSON.stringify(await panel(app, { name: 'tag', value: '' }))).toContain('"label":"Style"')
  // A tag no note has any more stops filtering.
  await panel(app, { name: 'tag', value: 'writing' })
  await tool(app, 'write_note', { name: 'Style', body: 'Short', scope: 'global' })
  expect(JSON.stringify(await panel(app))).toContain('"label":"Deploys"')
})

it("adds a note to the space's context from the popup, pasted into its next prompts", async () => {
  const { garage, create, tool, panel, session, handle, messages } = await start()
  const app = create('App')
  await tool(app, 'write_note', { name: 'Deploys', body: 'Ship on Fridays' })
  const file = join(garage, 'chats', app, 'notes', 'deploys.md')
  const before = JSON.stringify(await panel(app, { name: 'open', value: `${app}:deploys.md` }))
  expect(before).toContain('"label":"Add to context"')
  expect(session(app).instructions).not.toContain('Ship on Fridays')

  const after = JSON.stringify(await panel(app, { name: 'context', value: `${app}:deploys.md` }))
  expect(after).toMatch(/"label":"In context","disabled":true/)
  handle({ type: 'context.get', chatId: app })
  const context = messages.findLast((m) => m.type === 'chat.context' && m.chatId === app)
  expect(context?.type === 'chat.context' && context.items.map((i) => i.path)).toContain(realpathSync(file))
  expect(session(app).instructions).toContain('Ship on Fridays')

  // Home keeps no files, so it has no such button.
  await tool('main', 'write_note', { name: 'Style', body: 'Short' })
  expect(JSON.stringify(await panel('main', { name: 'open', value: 'global:style.md' }))).not.toContain('to context')
})

it('keeps what Kothar does not use when it saves a file: other front matter, no front matter, the file name', () => {
  const obsidian = '---\ntags:\n  - work\n  - ops\naliases: [Ship]\n---\nBody\n'
  const parsed = parseNote(obsidian, 'Projects/Deploy plan.md')
  expect(parsed).toMatchObject({ name: 'Deploy plan', description: '', body: 'Body\n', extra: ['tags:', '  - work', '  - ops', 'aliases: [Ship]'], noName: true, noDescription: true, tight: true })
  // Saved as it was read, it comes back byte for byte.
  expect(noteText(parsed.name, parsed.description, parsed.body, true, parsed)).toBe(obsidian)
  expect(frontMatterTags(parsed.extra)).toEqual(['work', 'ops'])
  expect(frontMatterTags(['tags: [a, "#b"]'])).toEqual(['a', 'b'])
  // A pin is a front matter line of its own.
  expect(parseNote(noteText('A', '', 'x', true, { pinned: true }), 'a.md')).toMatchObject({ name: 'A', pinned: true, body: 'x' })
  // Nothing to put in front matter: the body alone.
  expect(noteText('Plain', '', 'Just text', true, { noName: true, noDescription: true })).toBe('Just text')
})

it('reads notes in sub-folders, and saves a note in its own file and folder', async () => {
  const { garage, create, panel, tool } = await start()
  const app = create('App')
  const dir = join(garage, 'chats', app, 'notes')
  mkdirSync(join(dir, 'Projects'), { recursive: true })
  writeFileSync(join(dir, 'Projects', 'Kothar Plan.md'), 'Ship notes\n')
  writeFileSync(join(dir, 'Projects', 'tagged.md'), '---\ntags: [ops]\n---\n\nRun it\n')
  const all = JSON.stringify(await panel(app))
  expect(all).toContain(`"key":"${app}:Projects/Kothar Plan.md","label":"Kothar Plan"`)
  // The row shows only a time; its folder shows on hover.
  expect(all).toMatch(/"label":"Kothar Plan",[^{]*"action":\{[^}]*\},"detail":"[^"·]*","hint":"In Projects"/)
  // Front matter tags count as tags.
  expect(all).toContain('"label":"#ops"')
  await panel(app, { name: 'open', value: `${app}:Projects/Kothar Plan.md` })
  await panel(app, { name: 'write', value: 'Ship notes today\n' })
  // Same file, still no front matter.
  expect(readFileSync(join(dir, 'Projects', 'Kothar Plan.md'), 'utf8')).toBe('Ship notes today\n')
  // An agent's write to the same name replaces it in place too.
  await tool(app, 'write_note', { name: 'Kothar Plan', body: 'From the agent' })
  expect(readFileSync(join(dir, 'Projects', 'Kothar Plan.md'), 'utf8')).toBe('From the agent\n')
  expect((await tool(app, 'read_note', { name: 'kothar plan' })).text).toContain('From the agent')
  // Renamed, it gets a file from its new name, in the same folder.
  await panel(app, { name: 'renamed', value: { name: 'Roadmap', description: '' } })
  expect(readFileSync(join(dir, 'Projects', 'roadmap.md'), 'utf8')).toBe('---\nname: Roadmap\n---\n\nFrom the agent\n')
  expect(existsSync(join(dir, 'Projects', 'Kothar Plan.md'))).toBe(false)
})

it('points links at a renamed note in every note that sees it, never in code or at another note of that name', async () => {
  expect(relink('[[Old]] [[old|alias]] [[Old#Part]] `[[Old]]` [[Other]]', (t) => t.toLowerCase() === 'old', 'New')).toBe(
    '[[New]] [[New|alias]] [[New#Part]] `[[Old]]` [[Other]]',
  )
  const { garage, create, tool, panel } = await start()
  const app = create('App')
  const other = create('Other')
  await tool(app, 'write_note', { name: 'Style', body: 'Short words. See [[Style]].', scope: 'global' })
  await tool(app, 'write_note', { name: 'Index', body: 'Read [[Style|the style]] and [[Style#Words]]\n```\n[[Style]]\n```' })
  await tool(other, 'write_note', { name: 'Links', body: 'Also [[style]]' })
  // A space with its own note named Style keeps its links pointing there.
  const third = create('Third')
  await tool(third, 'write_note', { name: 'Style', body: 'Ours' })
  await tool(third, 'write_note', { name: 'Uses', body: '[[Style]]' })
  await panel(app, { name: 'open', value: 'global:style.md' })
  const shown = JSON.stringify(await panel(app, { name: 'renamed', value: { name: 'Writing style', description: '' } }))
  expect(shown).toContain('Updated links in 2 notes')
  expect(readFileSync(join(garage, 'chats', app, 'notes', 'index.md'), 'utf8')).toContain(
    'Read [[Writing style|the style]] and [[Writing style#Words]]\n```\n[[Style]]\n```',
  )
  expect(readFileSync(join(garage, 'chats', other, 'notes', 'links.md'), 'utf8')).toContain('Also [[Writing style]]')
  expect(readFileSync(join(garage, 'chats', third, 'notes', 'uses.md'), 'utf8')).toContain('[[Style]]')
  // Its own link to itself follows too.
  expect(readFileSync(join(garage, 'extensions', 'notes', 'writing-style.md'), 'utf8')).toContain('See [[Writing style]].')
})

it('pins notes on top, sorts by edited, made or title, and moves a note between global and the space', async () => {
  const { garage, create, tool, panel } = await start()
  const app = create('App')
  for (const name of ['Note 10', 'Note 2', 'Alpha']) {
    await tool(app, 'write_note', { name, body: name })
    await new Promise((r) => setTimeout(r, 15))
  }
  const labels = (view: ExtensionView, list: string) => {
    const found: string[] = []
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      const n = node as { type?: string; label?: string; items?: { label: string }[] }
      if (n.type === 'list' && n.label === list) found.push(...n.items!.map((i) => i.label))
      for (const child of Object.values(node)) walk(child)
    }
    walk(view)
    return found
  }
  // Last edited first out of the box.
  expect(labels(await panel(app), 'This space')).toEqual(['Alpha', 'Note 2', 'Note 10'])
  expect(labels(await panel(app, { name: 'sort', value: 'title' }), 'This space')).toEqual(['Alpha', 'Note 2', 'Note 10'].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))
  // The order is kept for every chat, in a hidden file that isn't a note.
  expect(readFileSync(join(garage, 'extensions', 'notes', '.prefs.json'), 'utf8')).toBe('{"sort":"title"}')
  const pinned = await panel(app, { name: 'pin', value: `${app}:note-10.md` })
  expect(labels(pinned, 'Pinned')).toEqual(['Note 10'])
  expect(labels(pinned, 'This space')).toEqual(['Alpha', 'Note 2'])
  expect(readFileSync(join(garage, 'chats', app, 'notes', 'note-10.md'), 'utf8')).toContain('pinned: true')

  await panel(app, { name: 'open', value: `${app}:alpha.md` })
  const moved = JSON.stringify(await panel(app, { name: 'move', value: `${app}:alpha.md` }))
  expect(existsSync(join(garage, 'chats', app, 'notes', 'alpha.md'))).toBe(false)
  expect(existsSync(join(garage, 'extensions', 'notes', 'alpha.md'))).toBe(true)
  expect(moved).toContain('Moved to global notes')
  expect(moved).toContain('"label":"Move to this space"')
})

it('keeps a version changed outside Kothar while the user typed as a note of its own', async () => {
  const { garage, create, tool, panel } = await start()
  const app = create('App')
  await tool(app, 'write_note', { name: 'Plan', body: 'one' })
  await panel(app, { name: 'open', value: `${app}:plan.md` })
  const file = join(garage, 'chats', app, 'notes', 'plan.md')
  // Written by another app before Kothar looked again; then the editor saves what the user typed.
  writeFileSync(file, noteText('Plan', '', 'one, edited elsewhere'))
  const shown = JSON.stringify(await panel(app, { name: 'write', value: 'one, typed here\n' }))
  expect(readFileSync(file, 'utf8')).toContain('one, typed here')
  expect(readFileSync(join(garage, 'chats', app, 'notes', 'plan-changed-outside.md'), 'utf8')).toContain('one, edited elsewhere')
  expect(shown).toContain('changed outside Kothar while you typed')
  // A change the editor was shown is no conflict: saving over it makes no copy.
  writeFileSync(file, noteText('Plan', '', 'agent text'))
  await panel(app)
  await panel(app, { name: 'write', value: 'agent text, then mine\n' })
  expect(existsSync(join(garage, 'chats', app, 'notes', 'plan-changed-outside-2.md'))).toBe(false)
})

it('imports a folder of Markdown notes with their sub-folders and pictures, skipping what is already there', async () => {
  const { garage, create, panel } = await start()
  const app = create('App')
  const vault = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-vault-')))
  cleanups.push(() => rmSync(vault, { recursive: true, force: true }))
  mkdirSync(join(vault, 'Daily'))
  mkdirSync(join(vault, '.obsidian'))
  writeFileSync(join(vault, 'Home.md'), '# Home\n[[Daily/Monday]]\n')
  writeFileSync(join(vault, 'Daily', 'Monday.md'), 'Standup\n')
  writeFileSync(join(vault, 'Daily', 'shot.png'), 'png')
  writeFileSync(join(vault, '.obsidian', 'app.json'), '{}')
  writeFileSync(join(vault, 'notes.txt'), 'not a note')
  const shown = JSON.stringify(await panel(app, { name: 'import', value: { path: vault } }))
  expect(shown).toContain('Imported 2 notes and 1 picture or file')
  const dir = join(garage, 'chats', app, 'notes')
  expect(readFileSync(join(dir, 'Home.md'), 'utf8')).toBe('# Home\n[[Daily/Monday]]\n')
  expect(existsSync(join(dir, 'Daily', 'shot.png'))).toBe(true)
  expect(existsSync(join(dir, '.obsidian'))).toBe(false)
  expect(existsSync(join(dir, 'notes.txt'))).toBe(false)
  expect(shown).toContain('"label":"Monday"')
  // Again: the same files are skipped; a changed one comes in beside it.
  writeFileSync(join(vault, 'Home.md'), '# Home, changed\n')
  expect(JSON.stringify(await panel(app, { name: 'import', value: vault }))).toContain('Imported 1 note; 2 already here')
  expect(readFileSync(join(dir, 'Home 2.md'), 'utf8')).toBe('# Home, changed\n')
  // A missing folder or the notes folder itself is refused, with the reason shown.
  expect(JSON.stringify(await panel(app, { name: 'import', value: join(vault, 'nope') }))).toContain('No folder at')
  expect(JSON.stringify(await panel(app, { name: 'import', value: dir }))).toContain('Pick a folder outside the notes folder')
})

it('finds notes by letters in order and by text with a snippet, and offers to make a note named as typed', async () => {
  expect(fuzzyMatches('Groceries', 'grcs')).toBe(true)
  expect(fuzzyMatches('Groceries', 'scrg')).toBe(false)
  expect(snippetOf('first\nwe ship on fridays only', 'FRIDAYS')).toBe('we ship on fridays only')
  const { create, tool, panel } = await start()
  const app = create('App')
  await tool(app, 'write_note', { name: 'Groceries', body: 'milk' })
  await tool(app, 'write_note', { name: 'Deploys', body: 'Ship on Fridays' })
  const fuzzy = JSON.stringify(await panel(app, { name: 'search', value: 'grcs' }))
  expect(fuzzy).toContain('"label":"Groceries"')
  // The letters it matched by are highlighted.
  expect(fuzzy).toContain('"marks":[[0,1],[1,2],[3,4],[8,9]]')
  expect(fuzzy).toContain('"label":"New note “grcs”","variant":"ghost"')
  const text = JSON.stringify(await panel(app, { name: 'search', value: 'fridays' }))
  // The line it matched shows under its name, the words highlighted.
  expect(text).toContain('"excerpt":{"text":"Ship on Fridays","marks":[[8,15]]}')
  // Nothing matches: making it is the main button.
  const none = JSON.stringify(await panel(app, { name: 'search', value: 'Trip ideas' }))
  expect(none).toContain('"label":"New note “Trip ideas”","variant":"primary"')
  const made = JSON.stringify(await panel(app, { name: 'create', value: { name: 'Trip ideas', scope: 'space' } }))
  expect(made).toContain(`"key":"${app}:trip-ideas.md","label":"Trip ideas","selected":true`)
  expect(made).toContain('"value":""')
})

it('names a note from its first line, counts words and shows times as a notes list does', () => {
  expect(titleFrom('\n# **Trip** to [[Lisbon|Lisboa]]\nmore')).toBe('Trip to Lisboa')
  expect(titleFrom('- [ ] buy milk')).toBe('buy milk')
  expect(titleFrom('a/b: c')).toBe('a b c')
  expect(titleFrom('word '.repeat(30)).length).toBeLessThanOrEqual(60)
  expect(wordCount('# Hello, world — it’s **two** things')).toBe(5)
  const now = new Date(2026, 5, 15, 12).getTime()
  expect(shortTime(now - 10_000, now)).toBe('just now')
  expect(shortTime(now - 5 * 60_000, now)).toBe('5m')
  expect(shortTime(now - 3 * 3_600_000, now)).toBe('3h')
  expect(shortTime(now - 30 * 3_600_000, now)).toBe('yesterday')
})

it('opens the best match on Enter in the search box, or makes the note typed, and offers note names to [[', async () => {
  const { garage, create, tool, panel } = await start()
  const app = create('App')
  await tool(app, 'write_note', { name: 'Groceries', body: 'milk' })
  await tool(app, 'write_note', { name: 'Deploys', body: 'Ship' })
  const best = JSON.stringify(await panel(app, { name: 'go', value: 'grc' }))
  expect(best).toContain(`"key":"${app}:groceries.md","label":"Groceries","selected":true`)
  expect(best).toContain('"submit":"go"')
  // The editor offers the other notes' names.
  expect(best).toContain('"completions":["Deploys"]')
  await panel(app, { name: 'go', value: 'Packing list' })
  expect(existsSync(join(garage, 'chats', app, 'notes', 'packing-list.md'))).toBe(true)
})

it('lists the notes that name a note without linking it', () => {
  const notes = [
    note({ key: 'a', name: 'Deploys' }),
    note({ key: 'b', name: 'Plan' }),
    note({ key: 'c', name: 'Linked' }),
    note({ key: 'd', name: 'Code' }),
    note({ key: 'e', name: 'Word' }),
  ]
  const bodies: Record<string, string> = {
    a: '',
    b: 'Before deploys (Fridays)',
    c: 'See [[Deploys]] and deploys',
    d: '`deploys` in code',
    e: 'redeploys is another word',
  }
  expect(mentionsOf(notes, notes[0]!, (n) => bodies[n.key]!).map((n) => n.key)).toEqual(['b'])
  expect(mentionsOf([note({ key: 'x', name: 'Go' }), note({ key: 'y', name: 'Y' })], note({ key: 'x', name: 'Go' }), () => 'go go')).toEqual([])
})

it('reads headings outside code, finds words and letters to highlight, and the pictures a note shows', () => {
  expect(headingsIn('# One\ntext\n```\n# not\n```\n## Two [[Link|shown]] ##\n####### seven\n#tag')).toEqual([
    { level: 1, text: 'One', line: 1 },
    { level: 2, text: 'Two shown', line: 6 },
  ])
  expect(wordRanges('Ship on fridays, Friday', 'FRIDAY ship')).toEqual([[0, 4], [8, 14], [17, 23]])
  expect(fuzzyRanges('Groceries', 'grcs')).toEqual([[0, 1], [1, 2], [3, 4], [8, 9]])
  expect(fuzzyRanges('Groceries', 'zz')).toEqual([])
  expect(attachmentsIn('![a](attachments/a.png) ![b](<attachments/b%20c.png>) ![x](../attachments/x.png) `![c](attachments/c.png)` ![d](attachments/../d.png)')).toEqual([
    'attachments/a.png',
    'attachments/b c.png',
  ])
})

it('links the first mention of a name, keeping how it was written, never in code, links or URLs', () => {
  expect(linkMention('About Deploys and deploys', 'Deploys')).toBe('About [[Deploys]] and deploys')
  expect(linkMention('the deploys list', 'Deploys')).toBe('the [[Deploys|deploys]] list')
  expect(linkMention('`deploys` [[Other|deploys]] [deploys](https://x/deploys) https://x/deploys then deploys', 'Deploys')).toBe(
    '`deploys` [[Other|deploys]] [deploys](https://x/deploys) https://x/deploys then [[Deploys|deploys]]',
  )
  expect(linkMention('redeploys', 'Deploys')).toBe('redeploys')
  expect(linkMention('a (C++) b', 'C++')).toBe('a ([[C++]]) b')
})

it("opens with the search box focused, or the editor for a note opened to type in; the editor reads the note's pictures", async () => {
  const { create, tool, panel } = await start()
  const app = create('App')
  await tool(app, 'write_note', { name: 'Plan', body: 'one' })
  const first = await panel(app)
  const find = (view: ExtensionView, type: string): any => JSON.parse(JSON.stringify(view), (_k, v) => v).side.children.find((c: any) => c.type === type) ?? findDeep(view, type)
  const findDeep = (view: unknown, type: string): any => {
    if (!view || typeof view !== 'object') return undefined
    if ((view as { type?: string }).type === type) return view
    for (const v of Object.values(view)) {
      const found = findDeep(v, type)
      if (found) return found
    }
  }
  // The note last edited is open, but quietly: the keyboard goes to search.
  expect(find(first, 'search').autofocus).toBe(true)
  expect(findDeep(first, 'editor')).toMatchObject({ autofocus: false, keep: 'keep', paste: 'picture', files: expect.stringMatching(/notes$/) })
  const opened = await panel(app, { name: 'open', value: `${app}:plan.md` })
  expect(find(opened, 'search').autofocus).toBe(false)
  expect(findDeep(opened, 'editor').autofocus).toBe(true)
})

it('"Keep mine" keeps the other version as a note of its own before the editor saves over it', async () => {
  const { garage, create, tool, panel } = await start()
  const app = create('App')
  await tool(app, 'write_note', { name: 'Plan', body: 'one' })
  await panel(app, { name: 'open', value: `${app}:plan.md` })
  const file = join(garage, 'chats', app, 'notes', 'plan.md')
  // The editor was shown the agent's text over unsent typing; the user keeps theirs.
  writeFileSync(file, noteText('Plan', '', 'agent text'))
  await panel(app)
  const kept = JSON.stringify(await panel(app, { name: 'keep', value: 'agent text' }))
  await panel(app, { name: 'write', value: 'my text' })
  expect(readFileSync(file, 'utf8')).toContain('my text')
  expect(readFileSync(join(garage, 'chats', app, 'notes', 'plan-changed-outside.md'), 'utf8')).toContain('agent text')
  expect(kept).toContain('That version is kept as “Plan (changed outside)”')
  // Only one copy: the write that follows isn't taken for another conflict.
  expect(existsSync(join(garage, 'chats', app, 'notes', 'plan-changed-outside-2.md'))).toBe(false)
})

it('saves a pasted picture beside the note, never over another or outside attachments/, and moves pictures with a note', async () => {
  const { garage, create, tool, panel, messages } = await start()
  const app = create('App')
  await tool(app, 'write_note', { name: 'Plan', body: 'one' })
  await panel(app, { name: 'open', value: `${app}:plan.md` })
  const dir = join(garage, 'chats', app, 'notes')
  const png = Buffer.from([137, 80, 78, 71]).toString('base64')
  await panel(app, { name: 'picture', value: { path: 'attachments/pasted-1.png', mimeType: 'image/png', data: png } })
  expect(readFileSync(join(dir, 'attachments', 'pasted-1.png'))).toEqual(Buffer.from([137, 80, 78, 71]))
  // Not over one that's there.
  const again = JSON.stringify(await panel(app, { name: 'picture', value: { path: 'attachments/pasted-1.png', mimeType: 'image/png', data: Buffer.from('x').toString('base64') } }))
  expect(again).toContain('already there')
  expect(readFileSync(join(dir, 'attachments', 'pasted-1.png'))).toEqual(Buffer.from([137, 80, 78, 71]))
  // Nowhere but attachments/, and only pictures.
  for (const path of ['../x.png', 'attachments/../../x.png', 'attachments/a b.png', 'attachments/x.svg', 'attachments/sub/x.png', 'x.png']) {
    expect(PASTED_PICTURE.test(path), path).toBe(false)
    await panel(app, { name: 'picture', value: { path, mimeType: 'image/png', data: png } })
  }
  expect(messages.filter((m) => m.type === 'error' || (m.type === 'extension.panel' && m.error)).length).toBeGreaterThan(0)
  for (const path of ['x.png', 'notes/x.png', 'attachments/x.svg']) expect(existsSync(join(garage, 'chats', app, path)), path).toBe(false)
  expect(existsSync(join(dir, 'x.png'))).toBe(false)
  // Moved to global notes, the note takes its pictures along.
  await panel(app, { name: 'write', value: 'one\n\n![](attachments/pasted-1.png)\n' })
  await panel(app, { name: 'move', value: `${app}:plan.md` })
  expect(existsSync(join(garage, 'extensions', 'notes', 'attachments', 'pasted-1.png'))).toBe(true)
})

it('shows an outline for a note with headings, which jumps the editor, and links a mention in one click', async () => {
  const { garage, create, tool, panel } = await start()
  const app = create('App')
  await tool(app, 'write_note', { name: 'Deploys', body: '# Deploys\n\n## Before\n\ntext\n\n## After\n\nmore' })
  await tool(app, 'write_note', { name: 'Plan', body: 'Check deploys first' })
  const open = JSON.stringify(await panel(app, { name: 'open', value: `${app}:deploys.md` }))
  expect(open).toContain('"type":"card","title":"Outline"')
  expect(open).toContain('"label":"\u2003After","action":{"name":"jump","value":7}')
  const jumped = JSON.stringify(await panel(app, { name: 'jump', value: 7 }))
  expect(jumped).toMatch(/"jump":\{"key":"[^"]+","line":7\}/)
  // A short note has none.
  expect(JSON.stringify(await panel(app, { name: 'open', value: `${app}:plan.md` }))).not.toContain('"title":"Outline"')
  const back = JSON.stringify(await panel(app, { name: 'open', value: `${app}:deploys.md` }))
  expect(back).toContain('"button":{"label":"Link","action":{"name":"link-mention","value":"' + app + ':plan.md"}')
  const linked = JSON.stringify(await panel(app, { name: 'link-mention', value: `${app}:plan.md` }))
  expect(readFileSync(join(garage, 'chats', app, 'notes', 'plan.md'), 'utf8')).toContain('Check [[Deploys|deploys]] first')
  // It's a backlink now, no longer a mention.
  expect(linked).toContain('"title":"Linked from"')
  expect(linked).not.toContain('"title":"Mentioned in"')
})

// Every view in a tree, depth first.
const viewsIn = (view: ExtensionView): ExtensionView[] => {
  const kids =
    view.type === 'stack' || view.type === 'row'
      ? view.children
      : view.type === 'card'
        ? view.children
        : view.type === 'split'
          ? [view.side, view.main]
          : []
  return [view, ...kids.flatMap(viewsIn)]
}

it('keeps the popup quiet: one New note button and a ⋯ menu for the rest, a note headed by its name and a ⋯ menu', async () => {
  const { create, tool, panel } = await start()
  const app = create('App')
  await tool(app, 'write_note', { name: 'Deploys', description: 'How we ship', body: 'Ship on Fridays #ops' })
  const list = viewsIn((await panel(app)) as ExtensionView)
  const side = list.find((v) => v.type === 'split')
  const sideViews = side?.type === 'split' ? viewsIn(side.side) : []
  const buttons = sideViews.filter((v) => v.type === 'button').map((v) => v.type === 'button' && v.label)
  // Besides the tag row's #ops, New note is the only button in the list.
  expect(buttons).toEqual(['New note', '#ops'])
  const menus = sideViews.filter((v) => v.type === 'menu')
  expect(menus).toHaveLength(1)
  const labels = menus[0]!.type === 'menu' ? menus[0]!.items.map((i) => ('label' in i ? i.label : '—')) : []
  expect(labels).toEqual(['New global note', '—', 'Sort by edited', 'Sort by created', 'Sort by title', '—', 'Import folder…', 'Import from path…', 'Show folder'])

  const open = viewsIn((await panel(app, { name: 'open', value: `${app}:deploys.md` })) as ExtensionView)
  // No badges or always-on metadata: where it's kept, when edited and how long show on hovering the name.
  expect(open.some((v) => v.type === 'badge')).toBe(false)
  const name = open.find((v) => v.type === 'heading' && v.text === 'Deploys')
  expect(name?.type === 'heading' && name.hint).toMatch(/^How we ship\nThis space\nEdited .* · 4 words$/)
  const noteMenu = open.find((v) => v.type === 'menu' && v.label === 'More for Deploys')
  expect(noteMenu?.type === 'menu' && noteMenu.items.map((i) => ('label' in i ? i.label : '—'))).toEqual([
    'Add to context',
    'Pin',
    'Rename',
    'Move to global',
    'Show in Finder',
    '—',
    'Delete',
  ])
})
