import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatDetail, EngineEvent, Extension, ExtensionHost, ExtensionWaitAnswer } from '@kothar/extension-api'
import { afterEach, expect, it } from 'vitest'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore, type Core } from './core.ts'
import type { Adapter, CoreMessage } from './shared.ts'

const dirs: string[] = []
const cores: Core[] = []
afterEach(async () => {
  await Promise.all(cores.splice(0).map((core) => core.close(true)))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// An engine whose turn runs until the test ends it, as one waiting on a long tool call does.
function holdingEngine() {
  const turns: ((event: EngineEvent) => void)[] = []
  const adapter: Adapter = {
    id: 'hold',
    detect: async () => ({ installed: true, signedIn: true }),
    start(_machine, _options, emit) {
      return {
        prompt() {
          turns.push(emit)
          emit({ type: 'turn.started' })
        },
        steer() {},
        interrupt() {
          emit({ type: 'turn.completed', error: 'Interrupted' })
        },
        respond() {},
        close() {},
      }
    },
  }
  return { adapter, end: () => turns.at(-1)!({ type: 'turn.completed' }) }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

function start(extensions: Extension[]) {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-waits-')))
  dirs.push(garage)
  const engine = holdingEngine()
  const core = openCore({ garage, adapters: [engine.adapter], defaultEngine: 'hold', machine: sandboxingMachine, extensions })
  cores.push(core)
  core.handle({ type: 'engine.setEnabled', engine: 'hold', enabled: true }, () => {})
  core.handle({ type: 'workFolder.set', path: join(garage, 'work') }, () => {})
  for (const extension of extensions) core.handle({ type: 'extension.setEnabled', extensionId: extension.id, enabled: true }, () => {})
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const handle = (m: Parameters<Core['handle']>[0]) => core.handle(m, () => {})
  handle({ type: 'chat.create', name: 'Space' })
  const chatId = core.chats().at(-1)!.id
  const status = () => core.chats().find((c) => c.id === chatId)!.status
  return { core, engine, messages, handle, chatId, status }
}

it('lets an extension put a running chat in waiting with buttons, answered by a click or a message', async () => {
  let host!: ExtensionHost
  const answers: ExtensionWaitAnswer[] = []
  const extension: Extension = {
    id: 'waiter',
    name: 'Waiter',
    description: '',
    enabledByDefault: true,
    onStart: ({ host: given }) => void (host = given),
    onWaitAction: (_chat: ChatDetail, answer) => void answers.push(answer),
  }
  const t = start([extension])
  await t.core.refreshEngines()
  await until(() => !!host)
  expect(() => host.wait(t.chatId, { text: 'x', buttons: [] })).toThrow('only while its turn runs')
  t.handle({ type: 'chat.send', chatId: t.chatId, text: 'Go' })
  expect(t.status()).toBe('running')

  const wait = { text: 'Log in, then click Done', buttons: [{ id: 'done', label: 'Done', primary: true }] }
  host.wait(t.chatId, wait)
  expect(t.status()).toBe('waiting')
  expect(t.messages).toContainEqual({ type: 'chat.waits', chatId: t.chatId, waits: [{ extension: 'waiter', ...wait }] })
  expect(t.core.chats().find((c) => c.id === t.chatId)!.waits).toEqual([{ extension: 'waiter', ...wait }])

  t.handle({ type: 'extension.wait.answer', chatId: t.chatId, extension: 'waiter', button: 'done' })
  expect(() => t.handle({ type: 'extension.wait.answer', chatId: t.chatId, extension: 'waiter', button: 'nope' })).toThrow(
    'No button "nope"',
  )
  t.handle({ type: 'chat.send', chatId: t.chatId, text: 'I logged in' })
  expect(answers).toEqual([{ button: 'done' }, { message: 'I logged in' }])
  // The wait stays until the extension ends it; then the chat runs on.
  expect(t.status()).toBe('waiting')
  host.endWait(t.chatId)
  expect(t.status()).toBe('running')
  expect(t.messages.at(-2)).toEqual({ type: 'chat.waits', chatId: t.chatId, waits: [] })

  // A turn that ends takes its waits with it. (The message sent above runs as the next turn.)
  host.wait(t.chatId, wait)
  t.engine.end()
  expect(t.messages).toContainEqual({ type: 'chat.status', chatId: t.chatId, status: 'idle' })
  expect(t.core.chats().find((c) => c.id === t.chatId)!.waits).toBeUndefined()
  expect(() => t.handle({ type: 'extension.wait.answer', chatId: t.chatId, extension: 'waiter', button: 'done' })).toThrow(
    'Nothing is waiting',
  )
})

it("lists other extensions' Processes rows, runs their actions in the extension that owns them, and tells the others of changes", async () => {
  let ownerHost!: ExtensionHost
  let drawerHost!: ExtensionHost
  const actions: string[] = []
  const redraws: string[] = []
  const owner: Extension = {
    id: 'owner',
    name: 'Owner',
    description: '',
    enabledByDefault: true,
    onStart: ({ host }) => void (ownerHost = host),
    processes: (spaceId) => [{ key: 'b', label: `Browser of ${spaceId}`, actions: [{ name: 'stop', label: 'Stop' }] }],
    onProcessAction: (spaceId, key, action) => void actions.push(`${spaceId}/${key}/${action}`),
    onProcessesChanged: () => void redraws.push('owner'),
  }
  const drawer: Extension = {
    id: 'drawer',
    name: 'Drawer',
    description: '',
    enabledByDefault: true,
    onStart: ({ host }) => void (drawerHost = host),
    onProcessesChanged: (spaceId) => void redraws.push(`drawer ${spaceId}`),
  }
  await start([owner, drawer]).core.refreshEngines()
  await until(() => !!ownerHost && !!drawerHost)
  expect(drawerHost.processes('s1')).toEqual([
    { extension: 'owner', key: 'b', label: 'Browser of s1', actions: [{ name: 'stop', label: 'Stop' }] },
  ])
  // An extension doesn't get its own rows back.
  expect(ownerHost.processes('s1')).toEqual([])
  await drawerHost.processAction('s1', 'owner', 'b', 'stop')
  expect(actions).toEqual(['s1/b/stop'])
  ownerHost.processesChanged('s1')
  expect(redraws).toEqual(['drawer s1'])
})
