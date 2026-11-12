import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension, ExtensionHost, LimitReached } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, type FakeStep } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore } from './core.ts'
import type { ClientMessage } from './shared.ts'
import { until } from './test-wait.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// A core on the fake engine (fake-large, fake-small; default fake-small) whose sessions run into a usage limit, and an
// extension that keeps its host and every limit it hears of.
async function start() {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-chat-model-')))
  cleanups.push(() => rmSync(garage, { recursive: true, force: true }))
  const limits: LimitReached[] = []
  let host: ExtensionHost | undefined
  const extension: Extension = {
    id: 'watcher',
    name: 'Watcher',
    description: '',
    enabledByDefault: true,
    onChatCreated: (_chat, context) => void (host = context.host),
    onLimitReached: (limit) => void limits.push(limit),
  }
  const limited: FakeStep[] = [{ type: 'limit.reached', message: 'Out of usage' }]
  const core = openCore({
    garage,
    adapters: [createFakeAdapter(() => limited, 0)],
    defaultEngine: 'fake',
    machine: sandboxingMachine,
    extensions: [extension],
  })
  cleanups.push(() => core.close(true))
  const handle = (m: ClientMessage) => core.handle(m, () => {})
  handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
  handle({ type: 'workFolder.set', path: join(garage, 'work') })
  await core.refreshEngines()
  handle({ type: 'chat.create', name: 'Space' })
  const id = core.chats().findLast((c) => c.name === 'Space')!.id
  const chat = () => core.chats().find((c) => c.id === id)!
  return { core, handle, id, chat, limits, host: () => host! }
}

describe("a chat's model, for extensions", () => {
  it('is the model its next message runs on, as model choice picks it', async () => {
    const t = await start()
    expect(t.host().chat(t.id)?.model).toBe('fake-small')
    t.handle({ type: 'chat.setModel', chatId: t.id, engine: 'fake', model: 'fake-large' })
    expect(t.host().chat(t.id)?.model).toBe('fake-large')
    expect(t.host().chats().find((c) => c.id === t.id)?.model).toBe('fake-large')
  })

  it('comes with a usage limit as the model the turn ran on', async () => {
    const t = await start()
    t.handle({ type: 'chat.setModel', chatId: t.id, engine: 'fake', model: 'fake-large' })
    t.handle({ type: 'chat.send', chatId: t.id, text: 'Go' })
    await until(() => t.limits.length > 0 && t.chat().status === 'idle')
    expect(t.limits[0]).toMatchObject({ engine: 'fake', model: 'fake-large', message: 'Out of usage' })
  })

  // A chat busy with a turn stays on its engine until its next message starts, so a model on another engine would be
  // reported next to the wrong engine. It's left out instead, and comes back once the chat has moved.
  it('is absent while its model list has moved it to an engine it has not switched to yet', async () => {
    const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-chat-model-')))
    cleanups.push(() => rmSync(garage, { recursive: true, force: true }))
    let host: ExtensionHost | undefined
    const extension: Extension = {
      id: 'watcher',
      name: 'Watcher',
      description: '',
      enabledByDefault: true,
      onChatCreated: (_chat, context) => void (host = context.host),
    }
    const call = { toolId: 't1', name: 'Bash', kind: 'shell' as const, summary: 'touch x', input: { command: 'touch x' } }
    const asks: FakeStep[] = [{ type: 'tool.started', ...call }, { type: 'permission', ...call, output: 'ok' }]
    const core = openCore({
      garage,
      adapters: [{ ...createFakeAdapter(asks, 0), id: 'alpha' }, { ...createFakeAdapter([], 0), id: 'beta' }],
      defaultEngine: 'alpha',
      machine: sandboxingMachine,
      extensions: [extension],
    })
    cleanups.push(() => core.close(true))
    const handle = (m: ClientMessage) => core.handle(m, () => {})
    handle({ type: 'engine.setEnabled', engine: 'alpha', enabled: true })
    handle({ type: 'engine.setEnabled', engine: 'beta', enabled: true })
    handle({ type: 'workFolder.set', path: join(garage, 'work') })
    await core.refreshEngines()
    handle({ type: 'models.setList', role: 'chat', models: [{ engine: 'alpha', model: 'fake-small' }] })
    handle({ type: 'chat.create', name: 'Space' })
    const id = core.chats().findLast((c) => c.name === 'Space')!.id
    const detail = () => host!.chat(id)
    expect(detail()).toMatchObject({ engine: 'alpha', model: 'fake-small' })

    handle({ type: 'chat.send', chatId: id, text: 'Go' })
    await until(() => detail()?.status === 'waiting')
    handle({ type: 'models.setList', role: 'chat', models: [{ engine: 'beta', model: 'fake-large' }] })
    expect(detail()?.engine).toBe('alpha')
    expect(detail()).not.toHaveProperty('model')

    handle({ type: 'chat.interrupt', chatId: id, force: true })
    await until(() => detail()?.status === 'idle')
    handle({ type: 'chat.send', chatId: id, text: 'Again' })
    expect(detail()).toMatchObject({ engine: 'beta', model: 'fake-large' })
  })
})
