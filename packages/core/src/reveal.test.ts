import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionHost } from '@kothar/extension-api'
import { afterEach, expect, it } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore } from './core.ts'
import type { CoreMessage, Machine } from './shared.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-reveal-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A core whose Show in Finder is a stub (or, without one, a Machine that records what it runs), with a space on a
// folder of its own and an extension's host.
function start(stubbed = true) {
  const garage = tempDir()
  const folder = tempDir()
  const elsewhere = tempDir()
  const revealed: string[] = []
  const ran: string[][] = []
  const machine: Machine = { ...sandboxingMachine, run: async (command, args) => (ran.push([command, ...args]), { code: 0, stdout: '', stderr: '' }) }
  let host: ExtensionHost | undefined
  const core = openCore({
    garage,
    adapters: [createFakeAdapter([], 0)],
    defaultEngine: 'fake',
    machine: stubbed ? sandboxingMachine : machine,
    extensions: [
      { id: 'test', name: 'Test', description: '', enabledByDefault: true, onChatCreated: (_c, context) => void (host = context.host) },
    ],
    ...(stubbed && { reveal: async (path: string) => void revealed.push(path) }),
  })
  cleanups.push(() => core.close(true))
  const replies: CoreMessage[] = []
  const handle = (m: Parameters<typeof core.handle>[0]) => core.handle(m, (r) => replies.push(r))
  handle({ type: 'workFolder.set', path: join(garage, 'work') })
  handle({ type: 'chat.create', name: 'Space', folders: [folder] })
  return { garage, folder, elsewhere, revealed, ran, replies, handle, host: () => host! }
}

it("shows Kothar's own folders and a space's folders in Finder", async () => {
  const t = start()
  mkdirSync(join(t.folder, 'src'))
  writeFileSync(join(t.folder, 'src', 'a.ts'), '')
  await t.host().reveal(join(t.garage, 'chats'))
  await t.host().reveal(join(t.folder, 'src', 'a.ts'))
  await t.host().reveal(join(t.garage, 'work'))
  expect(t.revealed).toEqual([join(t.garage, 'chats'), join(t.folder, 'src', 'a.ts'), join(t.garage, 'work')])
})

it('refuses paths outside them, relative paths, paths out through .., and missing ones', async () => {
  const t = start()
  await expect(t.host().reveal(t.elsewhere)).rejects.toThrow("isn't in Kothar's data folder")
  await expect(t.host().reveal('chats')).rejects.toThrow("isn't in Kothar's data folder")
  await expect(t.host().reveal(join(t.folder, '..'))).rejects.toThrow("isn't in Kothar's data folder")
  await expect(t.host().reveal(join(t.folder, 'nope'))).rejects.toThrow("doesn't exist")
  expect(t.revealed).toEqual([])
})

it('answers the UI the same way, with an error for a refused path', async () => {
  const t = start()
  t.handle({ type: 'reveal', path: t.elsewhere })
  t.handle({ type: 'reveal', path: t.folder })
  await new Promise((r) => setTimeout(r, 10))
  expect(t.revealed).toEqual([t.folder])
  expect(t.replies.filter((r) => r.type === 'error').map((r) => (r as { message: string }).message)).toEqual([
    `${t.elsewhere} isn't in Kothar's data folder, the work folder or a space's folders`,
  ])
})

it('runs open -R through the Machine when the host gives no Finder of its own', async () => {
  const t = start(false)
  await t.host().reveal(t.folder)
  expect(t.ran).toContainEqual(['open', '-R', t.folder])
})
