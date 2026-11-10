import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension, ExtensionHost, LimitReached } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, type FakeStep } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore } from './core.ts'
import type { ClientMessage } from './shared.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error('timed out')
}

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
})
