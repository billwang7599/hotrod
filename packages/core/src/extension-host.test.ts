import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { type HostChat, type HostDeps, openExtensionHosts, storageAt } from './extension-host.ts'
import type { ChatInfo, CoreMessage } from './shared.ts'

const temps: string[] = []
afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-host-')))
  temps.push(dir)
  return dir
}

const extension: Extension = { id: 'demo', name: 'Demo', description: 'A test extension', enabledByDefault: true }
const chatAt = (dir: string, status: HostChat['status'] = 'idle'): HostChat => ({
  info: { id: 'c1', name: 'Chat', folders: [], files: [] } as unknown as ChatInfo,
  dir,
  entries: [],
  status,
})

// A host over one chat, with every other dependency a stub; overrides replace any of them.
const hostsWith = (chat: HostChat, overrides: Partial<HostDeps<HostChat>> = {}) => {
  const broadcasts: CoreMessage[] = []
  const unused = () => {
    throw new Error('not used in this test')
  }
  const deps: HostDeps<HostChat> = {
    garage: tempDir(),
    machine: { spawn: unused },
    chatOwnFiles: ['chat.json', 'log.jsonl'],
    isQuitting: () => false,
    extensions: [extension],
    extensionFor: () => extension,
    isOn: () => true,
    valuesOf: () => ({}),
    usesOf: () => undefined,
    extensionError: unused,
    processesChanged: unused,
    refresh: unused,
    chat: (id) => (id === chat.info.id ? chat : undefined),
    chatFor: (id) => {
      if (id !== chat.info.id) throw new Error(`No chat ${id}`)
      return chat
    },
    shown: () => true,
    shownChats: () => [chat],
    detailOf: unused,
    spaceOf: unused,
    reachable: () => true,
    createChat: unused,
    createChild: unused,
    enqueue: unused,
    interrupt: unused,
    retry: unused,
    continueTurn: unused,
    append: unused,
    setWait: unused,
    checkWait: (wait) => wait,
    spaceValuesOf: unused,
    setSpaceValue: unused,
    commandPlaceOf: unused,
    accounts: { list: () => [], use: unused },
    run: () => unused,
    complete: unused,
    broadcast: (message) => broadcasts.push(message),
    terminalRoots: () => [chat.dir],
    openTerminalAt: unused,
    reveal: unused,
    realOr: (path) => path,
    ...overrides,
  }
  return { ...openExtensionHosts(deps), broadcasts }
}

describe('storageAt', () => {
  it('reads, writes, appends and removes plain files under its folder', () => {
    const dir = tempDir()
    const storage = storageAt(dir, 'the store')

    expect(storage.read('missing.md')).toBeUndefined()
    storage.write('notes/a.md', 'one')
    storage.append('notes/a.md', ' two')
    expect(readFileSync(join(dir, 'notes/a.md'), 'utf8')).toBe('one two')
    storage.remove('notes/a.md')
    expect(storage.read('notes/a.md')).toBeUndefined()
  })

  it('refuses names that leave its folder or reach a reserved file, in any case', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'chat.json'), '{}')
    const storage = storageAt(dir, 'the store', ['chat.json'])

    expect(() => storage.read('../outside')).toThrow('"../outside" is outside the store')
    expect(() => storage.write('', 'x')).toThrow('is outside the store')
    expect(() => storage.read('CHAT.json')).toThrow('"CHAT.json" is outside the store')
  })
})

describe('openExtensionHosts', () => {
  it('makes one host per extension and a fresh one once forgotten', () => {
    const { hostFor, forgetHost } = hostsWith(chatAt(tempDir()))
    const first = hostFor(extension)

    expect(hostFor(extension)).toBe(first)
    forgetHost(extension.id)
    expect(hostFor(extension)).not.toBe(first)
  })

  it('guards a community extension’s host by what it declared', () => {
    const { hostFor } = hostsWith(chatAt(tempDir()), { usesOf: () => [] })

    expect(() => hostFor(extension).chats()).toThrow("Demo can't use host.chats")
  })

  it('keeps an extension’s chat storage off the core’s own files', () => {
    const chat = chatAt(tempDir())
    const storage = hostsWith(chat).hostFor(extension).chatStorage('c1')

    storage.write('mine.md', 'hello')
    expect(readFileSync(join(chat.dir, 'mine.md'), 'utf8')).toBe('hello')
    expect(() => storage.write('log.jsonl', 'x')).toThrow("Demo's files in this chat")
  })

  it('cuts a notification to what a system notification shows', () => {
    const { hostFor, broadcasts } = hostsWith(chatAt(tempDir()))

    hostFor(extension).notify({ chatId: 'c1', title: 't'.repeat(200), body: 'b'.repeat(500) })

    expect(broadcasts).toEqual([{ type: 'notify', extension: 'demo', title: 't'.repeat(120), body: 'b'.repeat(400), chatId: 'c1' }])
  })

  it('lets a chat wait only while its turn runs', () => {
    const waits: unknown[] = []
    const setWait = (_chat: HostChat, _id: string, wait: unknown) => void waits.push(wait)
    const wait = { text: 'Log in', buttons: [] }

    expect(() => hostsWith(chatAt(tempDir(), 'idle'), { setWait }).hostFor(extension).wait('c1', wait)).toThrow(
      'A chat waits for the user only while its turn runs',
    )
    hostsWith(chatAt(tempDir(), 'running'), { setWait }).hostFor(extension).wait('c1', wait)
    expect(waits).toEqual([wait])
  })

  it('takes a role only for a child chat', () => {
    const made: string[] = []
    const { hostFor } = hostsWith(chatAt(tempDir()), {
      createChat: ({ name }) => (made.push(`space ${name}`), {} as ChatInfo),
      createChild: (parentId, { name }) => (made.push(`child ${name} of ${parentId}`), {} as ChatInfo),
    })
    const host = hostFor(extension)

    expect(() => host.createChat({ name: 'A', role: 'workers' })).toThrow('Only a child chat (with parentId) takes a role')
    host.createChat({ name: 'B' })
    host.createChat({ name: 'C', parentId: 'c1' })
    expect(made).toEqual(['space B', 'child C of c1'])
  })

  it('opens a terminal only inside a chat’s folders', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'sub'))
    const opened: string[] = []
    const host = hostsWith(chatAt(dir), { openTerminalAt: async (path) => void opened.push(path) }).hostFor(extension)

    await host.openTerminal(join(dir, 'sub'))
    await expect(host.openTerminal('/elsewhere')).rejects.toThrow("/elsewhere isn't inside a space's folders")
    expect(opened).toEqual([join(dir, 'sub')])
  })

  it('starts no command while Kothar quits or the extension is off', async () => {
    const off = hostsWith(chatAt(tempDir()), { isOn: () => false }).hostFor(extension)
    const quitting = hostsWith(chatAt(tempDir()), { isQuitting: () => true }).hostFor(extension)

    await expect(off.spawn('true', [])).rejects.toThrow('Demo is off')
    await expect(quitting.spawn('true', [])).rejects.toThrow('Kothar is quitting')
  })
})
