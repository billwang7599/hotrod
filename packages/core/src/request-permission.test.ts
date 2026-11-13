import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityEvent, Extension, ExtensionHost } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, type FakeStep } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore } from './core.ts'
import { until } from './test-wait.ts'

// Generous: these tests share the machine with the whole suite.
const waitUntil = (check: () => boolean) => until(check, { tries: 600 })

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// A turn that waits on the engine's own permission, so the chat has a session for the extension to ask in.
const waiting: FakeStep[] = [
  { type: 'tool.started', toolId: 't1', name: 'Bash', kind: 'shell', summary: 'touch x', input: { command: 'touch x' } },
  { type: 'permission', toolId: 't1', name: 'Bash', kind: 'shell', summary: 'touch x', input: { command: 'touch x' }, output: 'created' },
  { type: 'text.completed', text: 'Done' },
]

function start(extra: Partial<Extension> = {}) {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-ask-')))
  cleanups.push(() => rmSync(garage, { recursive: true, force: true }))
  let host: ExtensionHost | undefined
  const events: ActivityEvent[] = []
  const relay: Extension = {
    id: 'relay',
    name: 'Relay',
    description: '',
    enabledByDefault: true,
    onChatCreated: (_chat, context) => void (host = context.host),
    onActivity: (event) => void events.push(event),
    ...extra,
  }
  const core = openCore({ garage, adapters: [createFakeAdapter(waiting, 0)], defaultEngine: 'fake', machine: sandboxingMachine, extensions: [relay] })
  cleanups.push(() => core.close(true))
  core.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true }, () => {})
  core.handle({ type: 'workFolder.set', path: join(garage, 'work') }, () => {})
  core.handle({ type: 'chat.create', name: 'Space' }, () => {})
  const id = core.chats()[0]!.id
  const entries = () => core.chats().find((chat) => chat.id === id)!.entries
  const asked = (name: string) => entries().findLast((e) => e.type === 'permission.requested' && e.name === name)
  const running = async () => {
    core.handle({ type: 'chat.send', chatId: id, text: 'go' }, () => {})
    await waitUntil(() => asked('Bash') !== undefined)
  }
  const respond = (requestId: string, allow: boolean) =>
    core.handle({ type: 'permission.respond', chatId: id, requestId, allow }, () => {})
  return { core, id, entries, asked, running, respond, events, host: () => host! }
}

const request = { name: 'mcp__github__create_issue', summary: 'GitHub: create_issue', input: { title: 'Bug' } }

describe('host.requestPermission', () => {
  it('shows the card in the chat and gives the user’s answer, recorded in the Activity', async () => {
    const t = start()
    await t.running()
    const answer = t.host().requestPermission(t.id, request)
    await waitUntil(() => t.asked(request.name) !== undefined)
    const card = t.asked(request.name)!
    expect(card).toMatchObject({ kind: 'mcp', summary: 'GitHub: create_issue', input: { title: 'Bug' } })
    if (card.type !== 'permission.requested') throw new Error('no card')
    t.respond(card.requestId, true)
    expect(await answer).toEqual({ allow: true, rule: 'You' })
    expect(t.entries().find((e) => e.type === 'permission.resolved' && e.requestId === card.requestId)).toMatchObject({ allow: true })
    expect(t.events.find((e) => e.kind === 'permission')).toMatchObject({ decision: 'allowed', rule: 'You' })
    // The engine's own request is still pending, and its answer still reaches the engine.
    const bash = t.asked('Bash')!
    if (bash.type !== 'permission.requested') throw new Error('no card')
    t.respond(bash.requestId, true)
    await waitUntil(() => t.core.chats()[0]!.status === 'idle')
  })

  it('takes an extension policy’s answer without asking, with that rule', async () => {
    const t = start({
      onPermissionRequested: (asked) => (asked.name.startsWith('mcp__github__') ? { allow: true } : undefined),
    })
    await t.running()
    expect(await t.host().requestPermission(t.id, request)).toMatchObject({ allow: true, rule: expect.stringContaining('Relay') })
  })

  it('refuses something that changes things in a read-only turn, but asks for a read', async () => {
    const t = start({ turnOptions: () => ({ readOnly: true, reason: 'Planning only' }) })
    await t.running()
    expect(await t.host().requestPermission(t.id, request)).toEqual({ allow: false, message: 'Planning only', rule: 'Read-only turn' })
    expect(t.asked(request.name)).toBeUndefined()
    const read = t.host().requestPermission(t.id, { ...request, name: 'mcp__github__get_issue' }, { changes: false })
    await waitUntil(() => t.asked('mcp__github__get_issue') !== undefined)
    t.core.handle({ type: 'chat.interrupt', chatId: t.id }, () => {})
    expect(await read).toMatchObject({ allow: false })
  })

  it('denies a request still open when the turn ends', async () => {
    const t = start()
    await t.running()
    const answer = t.host().requestPermission(t.id, request)
    await waitUntil(() => t.asked(request.name) !== undefined)
    t.core.handle({ type: 'chat.interrupt', chatId: t.id }, () => {})
    expect(await answer).toMatchObject({ allow: false, rule: 'The turn ended before it was answered' })
  })

  it('rejects with no turn running, and a request without a name', async () => {
    const t = start()
    await expect(t.host().requestPermission(t.id, request)).rejects.toThrow('has no turn running')
    await t.running()
    await expect(t.host().requestPermission(t.id, { name: '', summary: 'x' })).rejects.toThrow('needs a name')
  })
})
