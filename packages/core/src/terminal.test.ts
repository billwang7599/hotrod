import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore, type Core } from './core.ts'
import type { CoreMessage } from './shared.ts'
import { defaultTerminalOf, launchesFor, openTerminal, type Launch, type Spawner } from './terminal.ts'

let dirs: string[] = []
let cores: Core[] = []
afterEach(async () => {
  await Promise.all(cores.map((core) => core.close(true)))
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
  cores = []
})

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-terminal-')))
  dirs.push(dir)
  return dir
}

const notFound = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })

// Notes every launch; fail says which ones fail and how.
function spawner(fail: (launch: Launch) => Error | undefined = () => undefined) {
  const launches: Launch[] = []
  const spawn: Spawner = async (launch) => {
    launches.push(launch)
    const error = fail(launch)
    if (error) throw error
  }
  return { launches, spawn }
}

// The parts of ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist that matter, as
// `plutil -convert json` prints it after iTerm2's "Make iTerm2 Default Term".
const ITERM_PLIST = {
  LSHandlers: [
    { LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.google.chrome' },
    { LSHandlerContentType: 'public.html', LSHandlerRoleAll: 'com.apple.safari' },
    { LSHandlerContentType: 'com.apple.terminal.shell-script', LSHandlerRoleShell: 'com.googlecode.iterm2' },
    { LSHandlerContentType: 'public.unix-executable', LSHandlerRoleShell: 'com.googlecode.iterm2' },
  ],
}

describe('the default terminal on macOS', () => {
  it('is the app LaunchServices opens shell scripts with', () => {
    expect(defaultTerminalOf(ITERM_PLIST)).toBe('com.googlecode.iterm2')
    const ghostty = { LSHandlers: [{ LSHandlerContentType: 'public.unix-executable', LSHandlerRoleAll: 'com.mitchellh.ghostty' }] }
    expect(defaultTerminalOf(ghostty)).toBe('com.mitchellh.ghostty')
  })

  it('is none when nobody picked one', () => {
    expect(defaultTerminalOf({ LSHandlers: [{ LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.apple.mail' }] })).toBe(
      undefined,
    )
    expect(defaultTerminalOf({})).toBeUndefined()
    expect(defaultTerminalOf(undefined)).toBeUndefined()
    expect(defaultTerminalOf({ LSHandlers: 'nonsense' })).toBeUndefined()
  })
})

describe('what opens a terminal at a folder', () => {
  const dir = '/Users/me/my app'

  it('on macOS: the picked app, a folder-opening app by bundle id, CLI-flag apps with their own flag', () => {
    const mac = (choice?: string, bundle?: string) => launchesFor(dir, { platform: 'darwin', choice, bundle })
    expect(mac()).toEqual([{ command: 'open', args: ['-b', 'com.apple.Terminal', dir], wait: true }])
    expect(mac('auto', 'com.googlecode.iterm2')).toEqual([
      { command: 'open', args: ['-b', 'com.googlecode.iterm2', dir], wait: true },
      { command: 'open', args: ['-b', 'com.apple.Terminal', dir], wait: true },
    ])
    expect(mac('ghostty')).toEqual([{ command: 'open', args: ['-b', 'com.mitchellh.ghostty', dir], wait: true }])
    expect(mac('warp')).toEqual([{ command: 'open', args: ['-b', 'dev.warp.Warp-Stable', dir], wait: true }])
    expect(mac('iterm')).toEqual([{ command: 'open', args: ['-b', 'com.googlecode.iterm2', dir], wait: true }])
    expect(mac('kitty')).toEqual([
      { command: 'open', args: ['-n', '-b', 'net.kovidgoyal.kitty', '--args', '--directory', dir], wait: true },
    ])
    expect(mac('wezterm')).toEqual([
      { command: 'open', args: ['-n', '-b', 'com.github.wez.wezterm', '--args', 'start', '--cwd', dir], wait: true },
    ])
    expect(mac('alacritty')).toEqual([
      { command: 'open', args: ['-n', '-b', 'org.alacritty', '--args', '--working-directory', dir], wait: true },
    ])
    // A detected default Kothar knows takes its own flags; Terminal itself isn't tried twice.
    expect(mac(undefined, 'org.alacritty')[0]!.args).toContain('--working-directory')
    expect(mac(undefined, 'com.apple.Terminal')).toHaveLength(1)
  })

  it('on Linux: Debian’s alternative, $TERMINAL, then GNOME’s and KDE’s, all started in the folder', () => {
    expect(launchesFor(dir, { platform: 'linux', env: { TERMINAL: 'foot' } })).toEqual([
      { command: 'x-terminal-emulator', args: [], cwd: dir, wait: false },
      { command: 'foot', args: [], cwd: dir, wait: false },
      { command: 'gnome-terminal', args: [`--working-directory=${dir}`], cwd: dir, wait: false },
      { command: 'konsole', args: ['--workdir', dir], cwd: dir, wait: false },
    ])
    expect(launchesFor(dir, { platform: 'linux', env: {} }).map((l) => l.command)).not.toContain('')
  })

  it('on Windows: Windows Terminal, else a cmd window in the folder', () => {
    expect(launchesFor('C:\\code', { platform: 'win32' })).toEqual([
      { command: 'wt.exe', args: ['-d', 'C:\\code'], wait: false },
      { command: 'cmd.exe', args: ['/c', 'start', '', 'cmd.exe'], cwd: 'C:\\code', wait: false },
    ])
  })
})

describe('opening it', () => {
  it('reads LaunchServices for the automatic choice and opens that app, never through a shell', async () => {
    const dir = tempDir()
    const { launches, spawn } = spawner()
    await openTerminal(dir, { platform: 'darwin', spawner: spawn, launchServices: async () => ITERM_PLIST })
    expect(launches).toEqual([{ command: 'open', args: ['-b', 'com.googlecode.iterm2', dir], wait: true }])
  })

  it('falls back to Terminal when the detected app won’t open, or LaunchServices can’t be read', async () => {
    const dir = tempDir()
    const gone = spawner((l) => (l.args.includes('com.googlecode.iterm2') ? new Error('Unable to find application') : undefined))
    await openTerminal(dir, { platform: 'darwin', spawner: gone.spawn, launchServices: async () => ITERM_PLIST })
    expect(gone.launches.map((l) => l.args[1])).toEqual(['com.googlecode.iterm2', 'com.apple.Terminal'])
    const unread = spawner()
    await openTerminal(dir, {
      platform: 'darwin',
      spawner: unread.spawn,
      launchServices: async () => Promise.reject(new Error('plutil failed')),
    })
    expect(unread.launches).toEqual([{ command: 'open', args: ['-b', 'com.apple.Terminal', dir], wait: true }])
  })

  it('doesn’t read LaunchServices or fall back when the user picked an app, and says when it isn’t there', async () => {
    const dir = tempDir()
    let read = false
    const { launches, spawn } = spawner(() => new Error('Unable to find application'))
    const opening = openTerminal(dir, {
      platform: 'darwin',
      choice: 'ghostty',
      spawner: spawn,
      launchServices: async () => ((read = true), ITERM_PLIST),
    })
    await expect(opening).rejects.toThrow("Couldn't open Ghostty. Is it installed?")
    expect(read).toBe(false)
    expect(launches).toHaveLength(1)
  })

  it('on Linux, tries the next terminal when one isn’t installed, and says when none is', async () => {
    const dir = tempDir()
    const some = spawner((l) => (l.command === 'gnome-terminal' ? undefined : notFound()))
    await openTerminal(dir, { platform: 'linux', env: {}, spawner: some.spawn })
    expect(some.launches.map((l) => l.command)).toEqual(['x-terminal-emulator', 'gnome-terminal'])
    const none = spawner(() => notFound())
    await expect(openTerminal(dir, { platform: 'linux', env: {}, spawner: none.spawn })).rejects.toThrow(
      'No terminal app found',
    )
  })

  it('refuses a folder that’s gone, or a file, before starting anything', async () => {
    const dir = tempDir()
    const file = join(dir, 'notes.md')
    writeFileSync(file, '')
    const { launches, spawn } = spawner()
    await expect(openTerminal(join(dir, 'gone'), { platform: 'darwin', spawner: spawn })).rejects.toThrow(
      'The folder is gone',
    )
    await expect(openTerminal(file, { platform: 'darwin', spawner: spawn })).rejects.toThrow('The folder is gone')
    expect(launches).toEqual([])
  })
})

describe('terminal.open', () => {
  function start(settings: object = {}) {
    const garage = tempDir()
    writeFileSync(join(garage, 'settings.json'), JSON.stringify(settings))
    const opened: { dir: string; choice?: string }[] = []
    const fails = { message: '' }
    const adapter = createFakeAdapter([], 0)
    const core = openCore({
      garage,
      adapters: [adapter],
      defaultEngine: adapter.id,
      machine: sandboxingMachine,
      mods: [],
      openTerminal: async (dir, choice) => {
        if (fails.message) throw new Error(fails.message)
        opened.push({ dir, ...(choice && { choice }) })
      },
    })
    cores.push(core)
    const messages: CoreMessage[] = []
    core.onMessage((m) => messages.push(m))
    const replies: CoreMessage[] = []
    const handle = (m: Parameters<Core['handle']>[0]) => core.handle(m, (r) => replies.push(r))
    const results = () => replies.filter((r) => r.type === 'terminal.result')
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
    const create = (fields: { name: string; folders?: string[] }) => {
      handle({ type: 'chat.create', ...fields })
      const added = messages.findLast((m) => m.type === 'chat.added')
      if (added?.type !== 'chat.added') throw new Error('no chat.added')
      return added.chat
    }
    return { garage, handle, opened, fails, results, settle, create, messages }
  }

  it('opens a folder in the chat’s context, with the terminal from settings', async () => {
    const t = start({ terminal: 'ghostty' })
    const folder = tempDir()
    const chat = t.create({ name: 'App', folders: [folder] })
    t.handle({ type: 'terminal.open', chatId: chat.id, path: folder })
    await t.settle()
    expect(t.opened).toEqual([{ dir: folder, choice: 'ghostty' }])
    expect(t.results()).toEqual([{ type: 'terminal.result', chatId: chat.id, path: folder }])
  })

  it('saves the terminal picked in Settings, and goes back to automatic', async () => {
    const t = start()
    const folder = tempDir()
    const chat = t.create({ name: 'App', folders: [folder] })
    t.handle({ type: 'terminal.set', terminal: 'ghostty' })
    const updated = t.messages.findLast((m) => m.type === 'workFolder.updated')
    expect(updated?.type === 'workFolder.updated' && updated.workFolder.terminal).toBe('ghostty')
    expect(JSON.parse(readFileSync(join(t.garage, 'settings.json'), 'utf8')).terminal).toBe('ghostty')
    t.handle({ type: 'terminal.open', chatId: chat.id, path: folder })
    t.handle({ type: 'terminal.set', terminal: 'auto' })
    t.handle({ type: 'terminal.open', chatId: chat.id, path: folder })
    await t.settle()
    expect(t.opened).toEqual([{ dir: folder, choice: 'ghostty' }, { dir: folder }])
    expect(JSON.parse(readFileSync(join(t.garage, 'settings.json'), 'utf8')).terminal).toBeUndefined()
    expect(() => t.handle({ type: 'terminal.set', terminal: 'xterm; rm -rf /' })).toThrow('Unknown terminal')
  })

  it('offers the terminals Kothar knows only on macOS', () => {
    const t = start()
    t.handle({ type: 'terminal.set', terminal: 'auto' })
    const updated = t.messages.findLast((m) => m.type === 'workFolder.updated')
    const terminals = updated?.type === 'workFolder.updated' ? updated.workFolder.terminals : undefined
    if (process.platform === 'darwin') expect(terminals?.map((x) => x.name)).toContain('iTerm2')
    else expect(terminals).toBeUndefined()
  })

  it('refuses a folder that isn’t the chat’s, and one of another chat’s', async () => {
    const t = start()
    const mine = tempDir()
    const theirs = tempDir()
    const chat = t.create({ name: 'Mine', folders: [mine] })
    t.create({ name: 'Theirs', folders: [theirs] })
    for (const path of [theirs, join(mine, '..'), '/', 'relative', tempDir()]) {
      t.handle({ type: 'terminal.open', chatId: chat.id, path })
    }
    await t.settle()
    expect(t.opened).toEqual([])
    expect(t.results().map((r) => r.type === 'terminal.result' && r.error)).toEqual(
      Array(5).fill(expect.stringMatching(/isn't one of this chat's folders$/)),
    )
  })

  it('says why when the terminal won’t open', async () => {
    const t = start()
    const folder = tempDir()
    const chat = t.create({ name: 'App', folders: [folder] })
    t.fails.message = 'No terminal app found'
    t.handle({ type: 'terminal.open', chatId: chat.id, path: folder })
    await t.settle()
    expect(t.results()).toEqual([{ type: 'terminal.result', chatId: chat.id, path: folder, error: 'No terminal app found' }])
  })

  it('opens its space’s work folder and checkouts, from a subagent too', async () => {
    const t = start()
    const workDir = join(t.garage, 'work', 'space1')
    const checkout = join(workDir, 'app')
    mkdirSync(checkout, { recursive: true })
    const save = (id: string, fields: object) => {
      mkdirSync(join(t.garage, 'chats', id), { recursive: true })
      const chat = { id, engine: 'fake', createdAt: '2026-01-01T00:00:00.000Z', folders: [], files: [], ...fields }
      writeFileSync(join(t.garage, 'chats', id, 'chat.json'), JSON.stringify(chat))
    }
    save('space1', {
      name: 'Space',
      archived: false,
      workDir,
      worktrees: { '/src/app': { path: checkout, branch: 'kothar/app' } },
    })
    save('sub1', { name: 'Sub', parentId: 'space1', subagent: true })
    // A core opened on that garage loads them.
    cores.pop()?.close(true)
    const adapter = createFakeAdapter([], 0)
    const opened: string[] = []
    const core = openCore({
      garage: t.garage,
      adapters: [adapter],
      defaultEngine: adapter.id,
      machine: sandboxingMachine,
      mods: [],
      openTerminal: async (dir) => void opened.push(dir),
    })
    cores.push(core)
    const replies: CoreMessage[] = []
    for (const path of [workDir, checkout]) {
      core.handle({ type: 'terminal.open', chatId: 'sub1', path }, (r) => replies.push(r))
    }
    await t.settle()
    expect(opened).toEqual([workDir, checkout])
    expect(replies.every((r) => r.type === 'terminal.result' && !r.error)).toBe(true)
  })
})
