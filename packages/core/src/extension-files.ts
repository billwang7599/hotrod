import { realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { within } from './util.ts'

/**
 * Pictures an extension keeps in its own folders, served to the window (GET /extensions/<id>/files?path=…, token-checked
 * in server.ts) so an extension view can show them, such as a picture pasted into a note. Only plain pictures (no SVG,
 * which can carry script), only regular files, and only inside the extension's folders: its own storage folder
 * (<garage>/extensions/<id>/), and the chat folders its chatStorage writes to, outside the core's own files there
 * (chat.json, log.jsonl, AGENTS.md, attachments/…). Paths are resolved through symlinks before they're checked, so a link
 * can't lead out.
 */

export const PICTURE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
export const MAX_PICTURE_BYTES = 25 * 1024 * 1024

export type ExtensionFileRoots = {
  // The extension's own storage folder.
  storage: string
  // Every chat's folder, and the names in it that are the core's own.
  chatDirs: string[]
  chatOwnFiles: string[]
}

const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** The picture at path, if an extension with these folders may serve it; otherwise why not, for a 404's log. */
export function extensionPicture(path: string, roots: ExtensionFileRoots): { path: string; mimeType: string } | { error: string } {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return { error: 'not an absolute path' }
  const mimeType = PICTURE_TYPES[extname(path).toLowerCase()]
  if (!mimeType) return { error: 'not a picture' }
  const file = real(path)
  if (!file) return { error: 'no such file' }
  // The real file's type counts too, so a link named .png can't serve another kind of file.
  if (PICTURE_TYPES[extname(file).toLowerCase()] !== mimeType) return { error: 'not a picture' }
  const storage = real(roots.storage)
  const inStorage = !!storage && file !== storage && within(file, storage)
  const inChat = roots.chatDirs.some((dir) => {
    const chat = real(dir)
    if (!chat || file === chat || !within(file, chat)) return false
    const top = relative(chat, file).split(sep)[0]!.toLowerCase()
    return !roots.chatOwnFiles.some((own) => own.toLowerCase() === top)
  })
  if (!inStorage && !inChat) return { error: 'outside the extension’s folders' }
  const stat = statSync(file)
  if (!stat.isFile()) return { error: 'not a file' }
  if (stat.size > MAX_PICTURE_BYTES) return { error: 'too big' }
  return { path: file, mimeType }
}

export const extensionStorageDir = (garage: string, extensionId: string) => join(garage, 'extensions', extensionId)
