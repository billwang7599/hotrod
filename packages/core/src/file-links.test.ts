import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import type { Chat } from './chat.ts'
import { openCore } from './core.ts'
import { customLaunch, editorLaunch, installedEditors, splitCommand } from './editors.ts'
import { openFileLinks } from './file-links.ts'
import type { CoreMessage, Machine } from './shared.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-file-links-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const touch = (path: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
}

describe('editors', () => {
  const home = '/Users/me'
  const installed = new Set([
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    '/Users/me/Applications/Zed.app/Contents/MacOS/cli',
  ])
  const exists = (path: string) => installed.has(path)

  it('lists the editors installed in either Applications folder, on macOS only', () => {
    expect(installedEditors('darwin', home, exists)).toEqual([
      { id: 'vscode', name: 'Visual Studio Code' },
      { id: 'zed', name: 'Zed' },
    ])
    expect(installedEditors('linux', home, exists)).toEqual([])
  })

  it("opens at the line with each editor's own tool, and the system's app without one", () => {
    const spot = { file: '/a/b.ts', line: 52, col: 3 }
    const at = (choice?: string) => editorLaunch(spot, { choice, platform: 'darwin', home, exists })
    expect(at('vscode')).toEqual({
      command: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      args: ['-g', '/a/b.ts:52:3'],
    })
    expect(at('zed')).toEqual({ command: '/Users/me/Applications/Zed.app/Contents/MacOS/cli', args: ['/a/b.ts:52:3'] })
    expect(at()).toEqual({ command: 'open', args: ['/a/b.ts'] })
    expect(at('system')).toEqual({ command: 'open', args: ['/a/b.ts'] })
    expect(() => at('cursor')).toThrow("Couldn't find Cursor. Is it installed?")
    expect(editorLaunch({ file: '/a/b.ts' }, { choice: 'vscode', platform: 'darwin', home, exists }).args).toEqual(['/a/b.ts'])
    expect(editorLaunch(spot, { choice: 'vscode', platform: 'linux', home, exists })).toEqual({ command: 'xdg-open', args: ['/a/b.ts'] })
  })

  it('fills a custom command without a shell, adding the file when the command never names it', () => {
    expect(customLaunch('nvim-open "+{line}" {file}', { file: '/a b/c.ts', line: 4 })).toEqual({
      command: 'nvim-open',
      args: ['+4', '/a b/c.ts'],
    })
    expect(customLaunch('idea --line {line}', { file: '/x.ts' })).toEqual({ command: 'idea', args: ['--line', '1', '/x.ts'] })
    expect(splitCommand(`a 'b c' "d\\"e" f\\ g ''`)).toEqual(['a', 'b c', 'd"e', 'f g', ''])
    expect(() => splitCommand('a "b')).toThrow('unclosed quote')
    expect(() => customLaunch('  ', { file: '/x' })).toThrow('Set a command')
  })
})

// A space with a context folder, a work folder holding one checkout of it, and a garage folder.
function space() {
  const root = tempDir()
  const folder = join(root, 'code', 'app')
  const workDir = join(root, 'work', 'space')
  const checkout = join(workDir, 'app')
  const dir = join(root, 'garage', 'chats', 'space')
  const elsewhere = join(root, 'elsewhere')
  for (const d of [folder, checkout, dir, elsewhere]) mkdirSync(d, { recursive: true })
  const chat = {
    dir,
    info: { id: 'space', folders: [folder], files: [], workDir, worktrees: { [folder]: { path: checkout, branch: 'kothar/app' } } },
  } as unknown as Chat
  const ran: { command: string; args: string[]; cwd: string }[] = []
  const terminals: string[] = []
  let clock = 0
  let code = 0
  const links = openFileLinks({
    home: root,
    platform: 'darwin',
    machine: { run: async (command, args, { cwd }) => (ran.push({ command, args, cwd }), { code, stdout: '', stderr: code ? 'nope' : '' }) },
    now: () => new Date(clock),
    chainOf: (c) => [c],
    terminalRoots: () => [folder, workDir, checkout],
    openTerminalAt: async (d) => void terminals.push(d),
    editor: () => ({}),
  })
  return {
    root, folder, workDir, checkout, dir, elsewhere, chat, ran, terminals, links,
    tick: (ms: number) => (clock += ms),
    fail: () => (code = 1),
  }
}

describe('file links', () => {
  it('finds relative paths in the checkout first, then the work folder, the folder and the garage folder', () => {
    const t = space()
    touch(join(t.checkout, 'src', 'a.ts'))
    touch(join(t.folder, 'src', 'a.ts'))
    touch(join(t.folder, 'only-here.md'))
    touch(join(t.workDir, 'notes.txt'))
    touch(join(t.dir, 'attachments', 'pic.png'))
    expect(t.links.checkPaths(t.chat, ['src/a.ts', 'only-here.md', 'notes.txt', 'app/src/a.ts', 'attachments/pic.png', 'nope.ts'])).toEqual({
      'src/a.ts': join(t.checkout, 'src', 'a.ts'),
      'only-here.md': join(t.folder, 'only-here.md'),
      'notes.txt': join(t.workDir, 'notes.txt'),
      'app/src/a.ts': join(t.checkout, 'src', 'a.ts'),
      'attachments/pic.png': join(t.dir, 'attachments', 'pic.png'),
      'nope.ts': null,
    })
  })

  it("finds absolute and ~ paths only inside the chat's places, through symlinks and ..", () => {
    const t = space()
    touch(join(t.folder, 'a.ts'))
    touch(join(t.elsewhere, 'secret.txt'))
    symlinkSync(join(t.elsewhere, 'secret.txt'), join(t.folder, 'link.txt'))
    expect(t.links.checkPaths(t.chat, [
      join(t.folder, 'a.ts'),
      '~/code/app/a.ts',
      join(t.elsewhere, 'secret.txt'),
      '../../../elsewhere/secret.txt',
      'link.txt',
      '/etc/hosts',
      42,
    ])).toEqual({
      [join(t.folder, 'a.ts')]: join(t.folder, 'a.ts'),
      '~/code/app/a.ts': join(t.folder, 'a.ts'),
      [join(t.elsewhere, 'secret.txt')]: null,
      '../../../elsewhere/secret.txt': null,
      'link.txt': null,
      '/etc/hosts': null,
    })
  })

  it('keeps an answer for a few seconds, then looks again', () => {
    const t = space()
    expect(t.links.checkPaths(t.chat, ['late.ts'])).toEqual({ 'late.ts': null })
    touch(join(t.checkout, 'late.ts'))
    expect(t.links.checkPaths(t.chat, ['late.ts'])).toEqual({ 'late.ts': null })
    t.tick(10_000)
    expect(t.links.checkPaths(t.chat, ['late.ts'])).toEqual({ 'late.ts': join(t.checkout, 'late.ts') })
  })

  it('opens a file through the Machine at its folder, and a terminal at its folder', async () => {
    const t = space()
    touch(join(t.checkout, 'src', 'a.ts'))
    await t.links.openFile(t.chat, join(t.checkout, 'src', 'a.ts'), 52, 3)
    expect(t.ran).toEqual([{ command: 'open', args: [join(t.checkout, 'src', 'a.ts')], cwd: join(t.checkout, 'src') }])
    await t.links.openTerminalAtFile(t.chat, join(t.checkout, 'src', 'a.ts'))
    await t.links.openTerminalAtFile(t.chat, t.folder)
    expect(t.terminals).toEqual([join(t.checkout, 'src'), t.folder])
  })

  it('refuses paths outside, relative ones, missing ones, and says when the app fails', async () => {
    const t = space()
    touch(join(t.elsewhere, 'x.ts'))
    touch(join(t.folder, 'a.ts'))
    await expect(t.links.openFile(t.chat, join(t.elsewhere, 'x.ts'))).rejects.toThrow("isn't in this chat's folders")
    await expect(t.links.openFile(t.chat, 'a.ts')).rejects.toThrow("isn't in this chat's folders")
    await expect(t.links.openFile(t.chat, join(t.folder, '..', '..', 'elsewhere', 'x.ts'))).rejects.toThrow("isn't in")
    await expect(t.links.openFile(t.chat, join(t.folder, 'gone.ts'))).rejects.toThrow("doesn't exist")
    await expect(t.links.openTerminalAtFile(t.chat, join(t.elsewhere, 'x.ts'))).rejects.toThrow("isn't in")
    expect(t.ran).toEqual([])
    expect(t.terminals).toEqual([])
    t.fail()
    await expect(t.links.openFile(t.chat, join(t.folder, 'a.ts'))).rejects.toThrow('nope')
  })
})

describe('in the core', () => {
  function start() {
    const garage = tempDir()
    const folder = tempDir()
    const ran: string[][] = []
    const machine: Machine = {
      ...sandboxingMachine,
      run: async (command, args) => (ran.push([command, ...args]), { code: 0, stdout: '', stderr: '' }),
    }
    const opened: string[] = []
    const core = openCore({
      garage,
      adapters: [createFakeAdapter([], 0)],
      defaultEngine: 'fake',
      machine,
      openTerminal: async (dir) => void opened.push(dir),
    })
    cleanups.push(() => core.close(true))
    const replies: CoreMessage[] = []
    const broadcasts: CoreMessage[] = []
    core.onMessage((m) => broadcasts.push(m))
    const handle = (m: Parameters<typeof core.handle>[0]) => core.handle(m, (r) => replies.push(r))
    handle({ type: 'workFolder.set', path: join(garage, 'work') })
    handle({ type: 'chat.create', name: 'Space', folders: [folder] })
    const chatId = core.chats().find((c) => c.name === 'Space')!.id
    const settings = () => broadcasts.findLast((m) => m.type === 'workFolder.updated')
    return { garage, folder, ran, opened, replies, handle, chatId, settings }
  }

  it('answers files.check, opens with file.open, and refuses others with an error', async () => {
    const t = start()
    touch(join(t.folder, 'README.md'))
    t.handle({ type: 'files.check', chatId: t.chatId, paths: ['README.md', 'nope.md'] })
    const checked = t.replies.find((r) => r.type === 'files.checked')
    expect(checked).toMatchObject({ chatId: t.chatId, paths: { 'nope.md': null } })
    const path = (checked as { paths: Record<string, string> }).paths['README.md']!
    expect(path.endsWith('README.md')).toBe(true)
    t.handle({ type: 'file.open', chatId: t.chatId, path, line: 3 })
    t.handle({ type: 'file.open', chatId: t.chatId, path, in: 'terminal' })
    t.handle({ type: 'file.open', chatId: t.chatId, path: '/etc/hosts' })
    await new Promise((r) => setTimeout(r, 10))
    expect(t.ran).toContainEqual(['open', path])
    expect(t.opened).toEqual([join(path, '..')])
    expect(t.replies.filter((r) => r.type === 'error')).toEqual([
      { type: 'error', message: "/etc/hosts isn't in this chat's folders, checkouts or work folder" },
    ])
  })

  it('saves the editor and a custom command in settings.json', () => {
    const t = start()
    t.handle({ type: 'editor.set', editor: 'custom', command: 'myedit {file}:{line}' })
    expect(t.settings()).toMatchObject({ workFolder: { editor: 'custom', editorCommand: 'myedit {file}:{line}' } })
    t.handle({ type: 'editor.set', editor: 'system' })
    expect(t.settings()).toMatchObject({ workFolder: { editorCommand: 'myedit {file}:{line}' } })
    expect(t.settings()).not.toHaveProperty('workFolder.editor')
    expect(() => t.handle({ type: 'editor.set', editor: 'notepad' })).toThrow('Unknown editor "notepad"')
    expect(() => t.handle({ type: 'editor.set', editor: 'custom', command: 'a "b' })).toThrow('unclosed quote')
  })
})
