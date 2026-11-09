import { existsSync, readlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'

// Chromium's SingletonLock links to "<host>-<pid>" while that app runs, and may be left behind after a crash.
export function runningIn(dir: string) {
  try {
    const pid = Number(readlinkSync(join(dir, 'SingletonLock')).split('-').pop())
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Electron's own folder: Chromium's caches and the window's localStorage, where UI preferences (theme, panels, drafts,
// folds) live. It isn't the garage, which shares the app's name. The one from when Kothar was Hotrod moves to Kothar's
// name on the first launch after the rename, so those preferences come along. It stays in use where it is only while
// the old app still runs on it, or if the move fails.
export function userDataDir(
  appData: string,
  options: {
    exists?: (path: string) => boolean
    running?: (dir: string) => boolean
    rename?: (from: string, to: string) => void
    log?: (message: string) => void
  } = {},
) {
  const { exists = existsSync, running = runningIn, rename = renameSync, log = console.error } = options
  const dir = join(appData, 'Kothar Desktop')
  const old = join(appData, 'Hotrod Desktop')
  if (exists(dir) || !exists(old)) return dir
  if (running(old)) return old
  try {
    rename(old, dir)
    return dir
  } catch (error) {
    log(`Couldn't move ${old} to ${dir}: ${error instanceof Error ? error.message : String(error)}`)
    return old
  }
}
