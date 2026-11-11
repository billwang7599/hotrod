// Which folders the user's own apps may be opened at: Open in Terminal reaches a chat's folders, and Show in Finder
// reaches only Kothar's own folders. Anything else is refused, so neither a window nor an extension can point them
// anywhere it likes.
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Chat } from './chat.ts'
import type { Machine } from './shared.ts'
import { openTerminal } from './terminal.ts'
import { within } from './util.ts'

const REVEAL_TIMEOUT_MS = 10_000

// A path with its symlinks resolved, or just made absolute if it doesn't exist.
export const realOr = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export type FolderAccessDeps = {
  garage: string
  home: string
  machine: Pick<Machine, 'run'>
  // settings.json's work folder and terminal choice, read each time.
  workFolder: () => string | undefined
  terminal: () => string | undefined
  chainOf: (chat: Chat) => Chat[]
  shownChats: () => Chat[]
  // Opens a terminal app at a folder (tests pass a stub); defaults to terminal.ts.
  openTerminal?: (dir: string, choice?: string) => Promise<void>
  // Shows a path in Finder (the desktop app passes Electron's); defaults to `open -R` through the Machine.
  reveal?: (path: string) => Promise<void>
}

export function openFolderAccess(deps: FolderAccessDeps) {
  // Every folder a chat's Open in Terminal may open: its context folders, its space's work folder, and the checkouts
  // of its space and the chats above it.
  const terminalRoots = (chat: Chat) =>
    deps.chainOf(chat).flatMap(({ info }) =>
      info.extension
        ? []
        : [
            ...info.folders,
            ...(info.workDir ? [info.workDir] : []),
            ...Object.values(info.worktrees ?? {}).map((w) => w.path),
          ],
    )

  const openTerminalAt = (path: string) =>
    (deps.openTerminal ?? ((dir, choice) => openTerminal(dir, { choice, home: deps.home })))(path, deps.terminal())

  const terminalFor = async (chat: Chat, rawPath: unknown) => {
    const path = typeof rawPath === 'string' ? rawPath : ''
    if (!isAbsolute(path) || !terminalRoots(chat).some((root) => realOr(root) === realOr(path))) {
      throw new Error(`${path || 'That'} isn't one of this chat's folders`)
    }
    await openTerminalAt(path)
  }

  // Show in Finder: the garage, the work folder, and each chat's folders, files, work folder and checkouts.
  const revealRoots = () => {
    const workFolder = deps.workFolder()
    return [
      deps.garage,
      ...(workFolder ? [workFolder] : []),
      ...deps.shownChats().flatMap((chat) => [...terminalRoots(chat), ...chat.info.files]),
    ]
  }

  const reveal = async (rawPath: unknown) => {
    const path = typeof rawPath === 'string' ? rawPath : ''
    const real = realOr(path)
    if (!isAbsolute(path) || !revealRoots().map(realOr).some((root) => within(real, root))) {
      throw new Error(`${path || 'That'} isn't in Kothar's data folder, the work folder or a space's folders`)
    }
    if (!existsSync(real)) throw new Error(`${path} doesn't exist`)
    if (deps.reveal) return deps.reveal(real)
    const { code, stderr } = await deps.machine.run('open', ['-R', real], { cwd: '/', timeoutMs: REVEAL_TIMEOUT_MS })
    if (code !== 0) throw new Error(stderr.trim() || `Couldn't show ${path} in Finder`)
  }

  return { terminalRoots, openTerminalAt, terminalFor, reveal }
}
