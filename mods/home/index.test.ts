import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startCore } from '@kothar/core/main'
import type { Adapter, SessionOptions } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import home from './index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const homeChat = home.chats![0]!

async function start() {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-home-')))
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
  const kothar = await startCore({ env, adapters: [held], mods: [home], machine: sandboxingMachine })
  cleanups.push(async () => {
    await kothar.close(true)
    rmSync(garage, { recursive: true, force: true })
  })
  const handle = (message: Parameters<typeof kothar.core.handle>[0]) => kothar.core.handle(message, () => {})
  const send = (chatId: string, text: string) => {
    handle({ type: 'chat.send', chatId, text })
    return sessions.at(-1)!
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
    return (await response.json()).result
  }
  const tool = async (token: string, name: string, args: object = {}) => {
    const result = await rpc(token, 'tools/call', { name, arguments: args })
    return { isError: result.isError === true, text: result.content[0].text as string }
  }
  const names = async (token: string) =>
    (await rpc(token, 'tools/list', {})).tools.map((t: { name: string }) => t.name).sort()
  return { core: kothar.core, garage, sessions, handle, send, tool, names }
}

it('runs Home in the scratch folder with its instructions, and makes top-level spaces with create_chat', async () => {
  const { core, garage, sessions, send, tool, names } = await start()
  expect(core.chats().map((c) => c.id)).toEqual([homeChat.id])
  const session = send(homeChat.id, 'Set up the app')
  expect(session.options.cwd).toBe(join(garage, 'work', 'home'))
  expect(session.options.instructions.startsWith(homeChat.instructions)).toBe(true)
  const token = session.options.kotharMcp!.token
  expect(await names(token)).toEqual([
    'create_chat',
    'list_chats',
    'read_chat',
    'send_message',
    'spawn_worker',
    'stop_chat',
  ])

  expect(await tool(token, 'create_chat', { name: 'Bad', folders: ['relative/dir'] })).toEqual({
    isError: true,
    text: 'The path must be absolute: relative/dir',
  })
  const folder = join(garage, 'made', 'app')
  expect(await tool(token, 'create_chat', { name: 'App', folders: [folder] })).toEqual({
    isError: true,
    text: `No such folder: ${folder}; create_chat attaches existing folders only`,
  })
  expect(existsSync(join(garage, 'made'))).toBe(false)
  expect(core.chats()).toHaveLength(1)
  mkdirSync(folder, { recursive: true })
  const made = await tool(token, 'create_chat', { name: 'App', prompt: 'Look around', folders: [folder] })
  const { chatId } = JSON.parse(made.text)
  const space = core.chats().find((c) => c.id === chatId)
  expect(space).toMatchObject({ name: 'App', folders: [realpathSync(folder)], status: 'running' })
  expect(space).not.toHaveProperty('parentId')
  const options = { cwd: join(garage, 'work', chatId), extraDirs: [realpathSync(folder)] }
  expect(sessions.at(-1)).toMatchObject({ prompt: 'Look around', options })
  expect(JSON.parse((await tool(token, 'list_chats')).text).map((c: { id: string }) => c.id)).toEqual([chatId])
  expect(await names(sessions.at(-1)!.options.kotharMcp!.token)).toEqual([
    'list_chats',
    'read_chat',
    'send_message',
    'spawn_worker',
    'stop_chat',
  ])
})

it('hides Home while it is off, keeping its history, and shows it again once it is on', async () => {
  const { core, garage, handle, send } = await start()
  send(homeChat.id, 'Remember this')
  handle({ type: 'chat.interrupt', chatId: homeChat.id })
  handle({ type: 'chat.create', name: 'Space' })
  handle({ type: 'mod.setEnabled', modId: home.id, enabled: false })
  expect(core.chats().map((c) => c.name)).toEqual(['Space'])
  expect(readFileSync(join(garage, 'chats', homeChat.id, 'log.jsonl'), 'utf8')).toContain('Remember this')
  handle({ type: 'mod.setEnabled', modId: home.id, enabled: true })
  expect(core.chats().map((c) => c.name)).toEqual([homeChat.name, 'Space'])
})
