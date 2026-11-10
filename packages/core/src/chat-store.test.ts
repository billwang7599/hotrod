import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEntry, openSettings, quitMidTurn, readChat, saveChatFile, storedChatIds } from './chat-store.ts'
import type { ChatEntry, ChatInfo } from './shared.ts'

const temps: string[] = []
afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-store-')))
  temps.push(dir)
  return dir
}

const fallback = (id: string): ChatInfo =>
  ({ id, name: id, folders: [], files: [], engine: 'fake', archived: false, createdAt: '2026-01-01T00:00:00.000Z' }) as ChatInfo
const at = '2026-01-01T00:00:00.000Z'

describe('openSettings', () => {
  it('starts with no engines, and saves the same object it read', () => {
    const garage = tempDir()
    const { settings, save } = openSettings(garage)

    expect(settings.engines).toEqual({})
    expect(existsSync(join(garage, 'settings.json'))).toBe(false)
    settings.workFolder = '/work'
    save()
    expect(openSettings(garage).settings.workFolder).toBe('/work')
  })
})

describe('chat files', () => {
  it('writes chat.json with context only when a switch is set, and reads it back', () => {
    const dir = tempDir()
    saveChatFile(dir, fallback('c1'), {})
    expect(JSON.parse(readFileSync(join(dir, 'chat.json'), 'utf8'))).not.toHaveProperty('context')

    saveChatFile(dir, { ...fallback('c1'), name: 'Renamed' }, { 'files:/a.md': false })
    const read = readChat(dir, fallback('c1'))
    expect(read.info.name).toBe('Renamed')
    expect(read.context).toEqual({ 'files:/a.md': false })
    expect(read.resave).toBe(false)
  })

  it('makes a missing chat’s folder and asks for its chat.json to be written', () => {
    const dir = join(tempDir(), 'new')
    const read = readChat(dir, fallback('new'))

    expect(existsSync(dir)).toBe(true)
    expect(read).toEqual({ info: fallback('new'), context: {}, entries: [], resave: true })
  })

  it('reads the log in order', () => {
    const dir = tempDir()
    saveChatFile(dir, fallback('c1'), {})
    const entries: ChatEntry[] = [
      { at, type: 'user.message', text: 'hi' } as ChatEntry,
      { at, type: 'turn.completed' } as ChatEntry,
    ]
    entries.forEach((entry) => appendEntry(dir, entry))

    expect(readChat(dir, fallback('c1')).entries).toEqual(entries)
  })

  it('gives an extension’s own chat its declared name and no folders or files', () => {
    const dir = tempDir()
    saveChatFile(dir, { ...fallback('main'), name: 'Old', folders: ['/x'] }, {})

    const { info, resave } = readChat(dir, fallback('main'), { name: 'Home', extension: 'home' })

    expect(info).toMatchObject({ name: 'Home', extension: 'home', folders: [], files: [] })
    expect(resave).toBe(true)
  })

  it('keeps a parentId only on a worker', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'chat.json'), JSON.stringify({ ...fallback('c1'), parentId: 'p' }))

    const { info, resave } = readChat(dir, fallback('c1'))

    expect(info.parentId).toBeUndefined()
    expect(resave).toBe(true)
  })

  it('lists only folders with a chat.json', () => {
    const chats = tempDir()
    mkdirSync(join(chats, 'a'))
    writeFileSync(join(chats, 'a', 'chat.json'), '{}')
    mkdirSync(join(chats, 'empty'))

    expect(storedChatIds(chats)).toEqual(['a'])
  })
})

describe('quitMidTurn', () => {
  const entry = (type: string) => ({ at, type }) as ChatEntry

  it('is true when the log stops inside a turn or on a message nothing answered', () => {
    expect(quitMidTurn([entry('turn.started'), entry('text.completed')])).toBe(true)
    expect(quitMidTurn([entry('user.message')])).toBe(true)
    expect(quitMidTurn([entry('worker.report')])).toBe(true)
  })

  it('is false once the turn ended, or for an empty log', () => {
    expect(quitMidTurn([])).toBe(false)
    expect(quitMidTurn([entry('user.message'), entry('turn.started'), entry('turn.completed')])).toBe(false)
    expect(quitMidTurn([entry('turn.started'), entry('session.ended')])).toBe(false)
  })
})
