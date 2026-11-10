import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'
import type { ExtensionStorage, ExtensionView } from '@kothar/extension-api'
import { startCore } from '@kothar/core/main'
import type { Adapter, ClientMessage, CoreMessage, SessionOptions } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import { createSkillsExtension, MAX_INDEXED, skillIndex } from './index.ts'
import { createLibrary, type Skill } from './library.ts'
import { frontMatter, parseSkill, skillId, skillText } from './skill-md.ts'
import { engineSources, importAny, importEngine, importGitHub, parseGitHub, type Fetch } from './sources.ts'
import { readZip } from './zip.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const temp = (prefix = 'kothar-skills-') => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const skillMd = (name: string, description = `Use for ${name}`, body = `# ${name}\n`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`

// Plain files in a folder, as host.storage is.
function storageIn(dir: string): ExtensionStorage {
  return {
    dir,
    read: (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : undefined),
    write: (name, text) => write(join(dir, name), text),
    append: (name, text) => write(join(dir, name), (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '') + text),
    remove: (name) => rmSync(join(dir, name), { force: true }),
  }
}

const libraryIn = () => createLibrary(storageIn(temp()))

type TestEntry = { path: string; text?: string; deflate?: boolean; symlink?: boolean; encrypted?: boolean }

// A zip built in memory: each file stored or deflated, optionally a symlink or marked encrypted.
function zipOf(entries: TestEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path)
    const data = Buffer.from(entry.text ?? '')
    const packed = entry.deflate ? deflateRawSync(data) : data
    const method = entry.deflate ? 8 : 0
    const flags = entry.encrypted ? 1 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, packed)
    centrals.push(central, name)
    offset += 30 + name.length + packed.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centrals.reduce((n, b) => n + b.length, 0), 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

// SKILL.md

it('reads plain, quoted and block front matter, and skips nested maps', () => {
  const fields = frontMatter(
    [
      'name: pdf-forms  # a comment',
      'description: >',
      '  Fills PDF forms.',
      '  Use when asked to.',
      'license: "Apache: 2.0"',
      'metadata:',
      '  version: 1',
      'notes: |',
      '  line one',
      '  line two',
      "quoted: 'it''s'",
    ].join('\n'),
  )
  expect(fields).toEqual({
    name: 'pdf-forms',
    description: 'Fills PDF forms. Use when asked to.',
    license: 'Apache: 2.0',
    notes: 'line one\nline two',
    quoted: "it's",
  })
})

it('parses a SKILL.md, and says why one is not valid', () => {
  expect(parseSkill(skillMd('a', 'Does A'))).toMatchObject({ name: 'a', description: 'Does A', body: '\n# a\n' })
  expect(parseSkill('# no front matter')).toEqual({ error: expect.stringContaining('no front matter') })
  expect(parseSkill('---\nname: a\n---\nbody')).toEqual({ error: 'its SKILL.md has no description' })
  expect(parseSkill('---\ndescription: x\n---\n')).toEqual({ error: 'its SKILL.md has no name' })
  expect(parseSkill(`---\nname: a\ndescription: ${'x'.repeat(1025)}\n---\n`)).toEqual({ error: expect.stringContaining('1024') })
})

it('names a skill in lowercase with dashes, and writes a SKILL.md that reads back', () => {
  expect(skillId('My PDF Skill!')).toBe('my-pdf-skill')
  expect(skillId('***')).toBe('')
  const text = skillText('Release Notes', 'Use when: writing "notes" # always', '\n\nSteps\n')
  expect(parseSkill(text)).toMatchObject({ name: 'release-notes', description: 'Use when: writing "notes" # always', body: '\nSteps\n' })
})

// Zip

it('reads stored and deflated entries, leaving out folders and symlinks', () => {
  const entries = readZip(
    zipOf([
      { path: 'a/' },
      { path: 'a/SKILL.md', text: 'stored' },
      { path: 'a/big.txt', text: 'x'.repeat(5000), deflate: true },
      { path: 'a/link', text: '/etc/passwd', symlink: true },
    ]),
  )
  expect(entries.map((e) => [e.path, e.data.length])).toEqual([
    ['a/SKILL.md', 6],
    ['a/big.txt', 5000],
  ])
})

it('refuses encrypted zips, zips that unpack too big, and files that are not zips', () => {
  expect(() => readZip(zipOf([{ path: 'a', text: 'x', encrypted: true }]))).toThrow('Encrypted')
  expect(() => readZip(zipOf([{ path: 'a', text: 'x'.repeat(2000), deflate: true }]), 1000)).toThrow('unpacks to more than')
  expect(() => readZip(Buffer.from('not a zip at all, just some text here'))).toThrow("isn't a zip")
})

// Library

it('imports every valid skill in a folder, skipping invalid ones, duplicates and symlinks', () => {
  const library = libraryIn()
  const from = temp()
  const secret = join(temp(), 'secret.txt')
  write(secret, 'secret')
  write(join(from, 'skills', 'alpha', 'SKILL.md'), skillMd('alpha'))
  write(join(from, 'skills', 'alpha', 'scripts', 'run.sh'), 'echo hi')
  write(join(from, 'skills', 'alpha', '.git', 'HEAD'), 'ref')
  symlinkSync(secret, join(from, 'skills', 'alpha', 'leak.txt'))
  write(join(from, 'skills', 'beta', 'SKILL.md'), skillMd('Beta Skill'))
  write(join(from, 'skills', 'broken', 'SKILL.md'), '---\nname: broken\n---\n')
  write(join(from, 'zz-other', 'alpha', 'SKILL.md'), skillMd('alpha', 'A second alpha'))
  const result = library.importDir(from, 'Folder test', { on: true, follow: true })
  expect(result.imported).toEqual(['alpha', 'beta-skill'])
  expect(result.skipped).toEqual([
    { name: 'skills/broken', why: 'its SKILL.md has no description' },
    { name: 'alpha', why: 'another skill in this import has the same name' },
  ])
  // Folders are walked in name order, so the first alpha wins.
  const alpha = library.get('alpha')!
  expect(alpha).toMatchObject({ on: true, source: 'Folder test' })
  expect(library.filesOf(alpha)).toEqual(['SKILL.md', 'scripts/run.sh'])
  expect(existsSync(join(alpha.dir, 'leak.txt'))).toBe(false)
  expect(existsSync(join(alpha.dir, '.git'))).toBe(false)
  // Again: everything is already there.
  const again = library.importDir(from, 'Folder test', { on: true, follow: true })
  expect(again.imported).toEqual([])
  expect(again.skipped.filter((s) => s.why.startsWith('a skill with this name is already')).map((s) => s.name)).toEqual(['alpha', 'beta-skill', 'alpha'])
})

it('turns skills on and off, deletes them, and keeps a hand-made folder as a skill', () => {
  const library = libraryIn()
  write(join(library.root, 'by-hand', 'SKILL.md'), skillMd('by-hand'))
  write(join(library.root, 'not-a-skill', 'README.md'), 'hi')
  expect(library.list().map((s) => [s.id, s.on, s.source])).toEqual([['by-hand', true, 'Added by hand']])
  library.setOn('by-hand', false)
  expect(library.get('by-hand')!.on).toBe(false)
  library.setOn('by-hand', true)
  expect(library.get('by-hand')!.on).toBe(true)
  expect(() => library.remove('../escape')).toThrow('There is no skill')
  library.remove('by-hand')
  expect(library.list()).toEqual([])
})

it('reads only files inside a skill', () => {
  const library = libraryIn()
  write(join(library.root, 'a', 'SKILL.md'), skillMd('a'))
  write(join(library.root, 'a', 'ref', 'x.md'), 'X')
  write(join(library.root, 'b', 'SKILL.md'), skillMd('b'))
  const a = library.get('a')!
  expect(readFileSync(library.fileOf(a, 'ref/x.md'), 'utf8')).toBe('X')
  expect(() => library.fileOf(a, '../b/SKILL.md')).toThrow("isn't in the skill's folder")
  symlinkSync(join(library.root, 'b', 'SKILL.md'), join(library.root, 'a', 'sneaky.md'))
  expect(() => library.fileOf(a, 'sneaky.md')).toThrow("isn't in the skill's folder")
  expect(() => library.fileOf(a, 'missing.md')).toThrow('has no file')
})

it('makes a new skill, refusing a name already taken', () => {
  const library = libraryIn()
  expect(library.create('Release notes', 'Write release notes', '1. Read the log', 'Made by an agent in Test')).toBe('release-notes')
  expect(library.get('release-notes')).toMatchObject({ on: true, source: 'Made by an agent in Test', description: 'Write release notes' })
  expect(() => library.create('release notes', 'x', 'y', 'z')).toThrow('already exists')
  expect(() => library.create('!!', 'x', 'y', 'z')).toThrow('letters or digits')
  expect(() => library.create('c', '', 'y', 'z')).toThrow('no description')
})

it('imports a .skill archive without writing outside its scratch folder', () => {
  const library = libraryIn()
  const dir = temp()
  const archive = join(dir, 'forms.skill')
  writeFileSync(
    archive,
    zipOf([
      { path: 'forms/SKILL.md', text: skillMd('forms'), deflate: true },
      { path: 'forms/reference.md', text: 'ref' },
      { path: '../../escaped.txt', text: 'no' },
      { path: '/abs.txt', text: 'no' },
      { path: '__MACOSX/forms/._SKILL.md', text: 'junk' },
    ]),
  )
  const result = importAny(library, failingFetch, dir, archive)
  return result.then((r) => {
    expect(r).toMatchObject({ imported: ['forms'], skipped: [], source: `File ${archive}` })
    expect(library.filesOf(library.get('forms')!)).toEqual(['SKILL.md', 'reference.md'])
    expect(existsSync(join(dirname(library.root), '..', 'escaped.txt'))).toBe(false)
    expect(library.get('forms')!.on).toBe(true)
  })
})

// Sources

const failingFetch: Fetch = async () => {
  throw new Error('no network in tests')
}

it('reads GitHub repo, folder and file links', () => {
  expect(parseGitHub('https://github.com/anthropics/skills')).toEqual({ owner: 'anthropics', repo: 'skills' })
  expect(parseGitHub('github.com/a/b.git')).toEqual({ owner: 'a', repo: 'b' })
  expect(parseGitHub('https://github.com/a/b/tree/main/skills/pdf')).toEqual({ owner: 'a', repo: 'b', ref: 'main', path: 'skills/pdf' })
  expect(parseGitHub('https://github.com/a/b/blob/v1/skills/pdf/SKILL.md')).toEqual({ owner: 'a', repo: 'b', ref: 'v1', path: 'skills/pdf' })
  expect(parseGitHub('https://gitlab.com/a/b')).toBeUndefined()
})

it('imports from a GitHub folder, off, through the zipball', async () => {
  const library = libraryIn()
  const asked: string[] = []
  const zip = zipOf([
    { path: 'a-b-123/README.md', text: 'repo' },
    { path: 'a-b-123/skills/pdf/SKILL.md', text: skillMd('pdf'), deflate: true },
    { path: 'a-b-123/skills/pdf/forms.md', text: 'forms' },
    { path: 'a-b-123/skills/docx/SKILL.md', text: skillMd('docx') },
    { path: 'a-b-123/other/x/SKILL.md', text: skillMd('x') },
  ])
  const fetch: Fetch = async (url) => (asked.push(url), new Response(new Uint8Array(zip)))
  const result = await importGitHub(library, fetch, 'https://github.com/a/b/tree/main/skills')
  expect(asked).toEqual(['https://api.github.com/repos/a/b/zipball/main'])
  expect(result).toMatchObject({ source: 'GitHub a/b/skills (main)', imported: ['docx', 'pdf'] })
  expect(library.list().map((s) => [s.id, s.on])).toEqual([
    ['docx', false],
    ['pdf', false],
  ])
  const missing: Fetch = async () => new Response('', { status: 404 })
  await expect(importGitHub(library, missing, 'https://github.com/a/nope')).rejects.toThrow('GitHub has no public repo a/nope')
  await expect(importAny(library, fetch, '/', 'https://example.com/x.zip')).rejects.toThrow('Only GitHub links')
})

it("copies the skills of engines' own folders, following a linked skill folder", () => {
  const home = temp()
  const elsewhere = temp()
  write(join(elsewhere, 'linked', 'SKILL.md'), skillMd('linked'))
  write(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), skillMd('mine'))
  symlinkSync(join(elsewhere, 'linked'), join(home, '.claude', 'skills', 'linked'))
  write(join(home, '.codex', 'skills', '.system', 'sys', 'SKILL.md'), skillMd('sys'))
  write(join(home, 'pi-dir', 'skills', 'pi-skill', 'SKILL.md'), skillMd('pi-skill'))
  const sources = engineSources(home, { PI_CODING_AGENT_DIR: join(home, 'pi-dir') })
  expect(sources.map((s) => s.dir.replace(home, '~'))).toEqual(['~/.claude/skills', '~/.codex/skills', '~/.agents/skills', '~/pi-dir/skills'])
  const library = libraryIn()
  expect(library.newIn(sources[0]!.dir)).toEqual(['linked', 'mine'])
  expect(library.newIn(sources[1]!.dir)).toEqual([])
  expect(importEngine(library, sources[0]!).imported).toEqual(['linked', 'mine'])
  expect(importEngine(library, sources[3]!).imported).toEqual(['pi-skill'])
  expect(library.newIn(sources[0]!.dir)).toEqual([])
  // A copy, not a link: the original can go.
  rmSync(join(elsewhere, 'linked'), { recursive: true })
  expect(library.get('linked')!.on).toBe(true)
  expect(() => importEngine(library, sources[2]!)).toThrow("isn't a folder")
})

// The index

it('lists only skills that are on, one short line each, capped', () => {
  const skill = (id: string, on = true, description = `Use for ${id}`): Skill => ({ id, name: id, description, dir: '/x', on, source: 's' })
  expect(skillIndex([])).toBeUndefined()
  expect(skillIndex([skill('a', false)])).toBeUndefined()
  const index = skillIndex([skill('a'), skill('b', false), skill('c', true, 'y'.repeat(500))])!
  expect(index).toContain('- a: Use for a')
  expect(index).not.toContain('- b:')
  expect(index).toContain(`- c: ${'y'.repeat(199)}…`)
  const many = skillIndex(Array.from({ length: MAX_INDEXED + 5 }, (_, i) => skill(`s${i}`)))!
  expect(many).toContain('…and 5 more')
})

// In a running core

async function start(home: string, fetch: Fetch = failingFetch) {
  const garage = temp('kothar-skills-core-')
  const sessions: { options: SessionOptions }[] = []
  const held: Adapter = {
    id: 'held',
    kotharMcp: true,
    detect: async () => ({ installed: true, signedIn: true }),
    start(_machine, options, emit) {
      sessions.push({ options })
      return {
        prompt: () => emit({ type: 'turn.started' }),
        interrupt: () => emit({ type: 'turn.completed', error: 'Interrupted' }),
        respond() {},
        close() {},
      }
    },
  }
  const env = { KOTHAR_ENGINE: 'held', KOTHAR_GARAGE: garage, KOTHAR_WORK: join(garage, 'work'), KOTHAR_PORT: '0' }
  const kothar = await startCore({ env, adapters: [held], extensions: [createSkillsExtension({ home, env: {}, fetch })], machine: sandboxingMachine })
  cleanups.push(() => kothar.close(true))
  const { core } = kothar
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const handle = (message: ClientMessage) => core.handle(message, (m) => messages.push(m))
  const create = (name: string) => {
    handle({ type: 'chat.create', name })
    return core.chats().findLast((c) => c.name === name)!.id
  }
  const session = (chatId: string) => {
    handle({ type: 'chat.send', chatId, text: 'Hi' })
    const started = sessions.at(-1)!
    handle({ type: 'chat.interrupt', chatId })
    return started.options
  }
  const tool = async (chatId: string, name: string, args: object) => {
    handle({ type: 'chat.send', chatId, text: 'Go' })
    const token = sessions.at(-1)!.options.kotharMcp!.token
    const response = await fetch2(`http://127.0.0.1:${kothar.port}/mcp`, token, { name, arguments: args })
    handle({ type: 'chat.interrupt', chatId })
    return { isError: response.isError === true, text: response.content[0].text as string }
  }
  // The Settings page's view, after an action if one is given.
  const settings = async (action?: { name: string; value?: unknown }): Promise<ExtensionView> => {
    const updates = () => messages.filter((m) => m.type === 'extension.updated' && m.extension.id === 'skills')
    const seen = updates().length
    if (action) handle({ type: 'extension.settingsView.action', extensionId: 'skills', action } as ClientMessage)
    else handle({ type: 'extension.settingsView.get', extensionId: 'skills' })
    // An import draws "Importing…" first; wait for what follows.
    const done = () => {
      const last = updates().at(-1)
      return updates().length > seen && last?.type === 'extension.updated' && !textsOf(last.extension.settingsView?.view ?? { type: 'empty', text: '' }).some((t) => t.startsWith('Importing'))
    }
    for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5))
    const last = updates().at(-1)
    if (last?.type !== 'extension.updated' || !last.extension.settingsView?.view) throw new Error('no settings view')
    return last.extension.settingsView.view
  }
  return { garage, create, session, tool, settings }
}

async function fetch2(url: string, token: string, params: object) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  })
  return JSON.parse(await response.text()).result
}

const textsOf = (view: ExtensionView): string[] => {
  const out: string[] = []
  const walk = (node: ExtensionView) => {
    if ('text' in node && typeof node.text === 'string') out.push(node.text)
    if (node.type === 'card') out.push(node.title)
    if (node.type === 'button') out.push(node.label)
    if ('children' in node) node.children.forEach(walk)
  }
  walk(view)
  return out
}

it('imports from the Settings page, lists the index in instructions, and serves skills through the tools', async () => {
  const home = temp()
  write(join(home, '.claude', 'skills', 'deploy', 'SKILL.md'), skillMd('deploy', 'Ship the app to staging'))
  write(join(home, '.claude', 'skills', 'deploy', 'steps.md'), 'Run make ship')
  const from = join(home, 'mine', 'notes-style')
  write(join(from, 'SKILL.md'), skillMd('notes-style', 'House style for notes'))
  const kothar = await start(home)

  const empty = await kothar.settings()
  expect(textsOf(empty)).toContain('No skills yet. Import some below, or ask an agent to make one.')
  expect(textsOf(empty)).toContain('Claude Code (1 new)')

  expect(textsOf(await kothar.settings({ name: 'engine', value: 'claude' }))).toContain('Imported 1 from Claude Code: deploy.')
  const afterTyped = await kothar.settings({ name: 'import', value: { from: '~/mine/notes-style' } })
  expect(textsOf(afterTyped)).toContain(`Imported 1 from Folder ${from}: notes-style.`)
  expect(textsOf(await kothar.settings({ name: 'import', value: from }))).toContain(
    'Already in Kothar: notes-style',
  )
  expect(textsOf(await kothar.settings({ name: 'import', value: '/no/such/place' }))).toContain('/no/such/place doesn\'t exist')

  const chat = kothar.create('Work')
  const { instructions } = kothar.session(chat)
  expect(instructions).toContain('- deploy: Ship the app to staging')
  expect(instructions).toContain('- notes-style: House style for notes')

  const read = await kothar.tool(chat, 'read_skill', { name: 'deploy' })
  expect(read.isError).toBe(false)
  expect(read.text).toContain('Files: SKILL.md, steps.md')
  expect(read.text).toContain('description: Ship the app to staging')
  expect((await kothar.tool(chat, 'read_skill_file', { name: 'deploy', file: 'steps.md' })).text).toBe('Run make ship')
  expect((await kothar.tool(chat, 'read_skill_file', { name: 'deploy', file: '../notes-style/SKILL.md' })).isError).toBe(true)

  // Off: gone from the index and the tools.
  await kothar.settings({ name: 'off', value: 'deploy' })
  expect(kothar.session(chat).instructions).not.toContain('- deploy:')
  const off = await kothar.tool(chat, 'read_skill', { name: 'deploy' })
  expect(off).toEqual({ isError: true, text: expect.stringContaining('No skill named deploy is on. Skills that are: notes-style') })

  const made = await kothar.tool(chat, 'create_skill', { name: 'Tidy Imports', description: 'Sort imports', body: 'Sort them.' })
  expect(made.text).toContain('Saved skill tidy-imports')
  expect(kothar.session(chat).instructions).toContain('- tidy-imports: Sort imports')

  const deleted = await kothar.settings({ name: 'delete', value: 'notes-style' })
  expect(textsOf(deleted)).not.toContain('notes-style')
  expect(textsOf(deleted)).toEqual(expect.arrayContaining(['deploy', 'tidy-imports', 'Turn on']))
})

it('adds nothing to instructions with no skills on', async () => {
  const kothar = await start(temp())
  expect(kothar.session(kothar.create('Plain')).instructions).not.toContain('Skills:')
})
