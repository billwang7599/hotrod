import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension, ExtensionHost } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore } from './core.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// Two extensions: `maker` offers a tool, `caller` calls it through its host.
function start(offered = true) {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-calltool-')))
  cleanups.push(() => rmSync(garage, { recursive: true, force: true }))
  const made: unknown[] = []
  const maker: Extension = {
    id: 'maker',
    name: 'Maker',
    description: '',
    enabledByDefault: true,
    settings: [{ key: 'prefix', label: 'Prefix', type: 'text', default: 'made' }],
    tools: [
      {
        name: 'make_thing',
        description: 'Makes a thing',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        offered: () => offered,
        async run(input, { caller, values }) {
          if (typeof input.title !== 'string') throw new Error('title is required')
          made.push({ caller: caller.name, title: input.title })
          return { id: `${values.prefix}-${input.title}` }
        },
      },
    ],
  }
  let host: ExtensionHost | undefined
  const caller: Extension = { id: 'caller', name: 'Caller', description: '', enabledByDefault: true, onChatCreated: (_c, context) => void (host = context.host) }
  const core = openCore({ garage, adapters: [createFakeAdapter([], 0)], defaultEngine: 'fake', machine: sandboxingMachine, extensions: [maker, caller] })
  cleanups.push(() => core.close(true))
  core.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true }, () => {})
  core.handle({ type: 'chat.create', name: 'Space' }, () => {})
  const id = core.chats()[0]!.id
  return { core, id, made, host: () => host! }
}

describe('host.callTool', () => {
  it('runs another extension’s tool as the chat’s agent would, with its own settings', async () => {
    const t = start()
    expect(await t.host().callTool(t.id, 'make_thing', { title: 'report' })).toEqual({ id: 'made-report' })
    expect(t.made).toEqual([{ caller: 'Space', title: 'report' }])
  })

  it('passes on the tool’s own error', async () => {
    const t = start()
    await expect(t.host().callTool(t.id, 'make_thing', {})).rejects.toThrow('title is required')
  })

  it('refuses a tool that doesn’t exist, isn’t offered to the chat, or whose extension is off', async () => {
    const t = start()
    await expect(t.host().callTool(t.id, 'nope', {})).rejects.toThrow('No tool "nope" is on for Space')
    t.core.handle({ type: 'extension.setEnabled', extensionId: 'maker', enabled: false }, () => {})
    await expect(t.host().callTool(t.id, 'make_thing', { title: 'x' })).rejects.toThrow('No tool "make_thing" is on for Space')
    const hidden = start(false)
    await expect(hidden.host().callTool(hidden.id, 'make_thing', { title: 'x' })).rejects.toThrow('No tool "make_thing"')
    expect(t.made).toEqual([])
  })
})
