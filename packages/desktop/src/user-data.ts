import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Electron's own folder: Chromium's caches and the window's localStorage, where UI preferences (theme, panels, drafts,
// folds) live. It isn't the garage, which shares the app's name. One from when Kothar was Hotrod stays in use, so
// those preferences survive the rename; a fresh install gets Kothar's own.
export function userDataDir(appData: string, exists: (path: string) => boolean = existsSync) {
  const dir = join(appData, 'Kothar Desktop')
  const old = join(appData, 'Hotrod Desktop')
  return !exists(dir) && exists(old) ? old : dir
}
