// The garage's plain files for settings and chats (design rule 9): settings.json, and each chat's chat.json and
// log.jsonl, with the renames older installs need. Only reads and writes; the core keeps chats in memory and decides
// when to save.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelSettings } from './models.ts'
import type { ChatEntry, ChatInfo, ContextSection, PermissionSwitches } from './shared.ts'
import { renameChatFile, renameEntry, renameSettings } from './vocab-move.ts'

export type Settings = PermissionSwitches &
  ModelSettings & {
    context?: Partial<Record<ContextSection, boolean>>
    extensions?: Record<string, Record<string, unknown>>
    // The version of each extension's saved settings (Extension.settingsVersion), once one has been migrated.
    extensionVersions?: Record<string, number>
    workFolder?: string
    // The master switch for community extensions; off unless the user turned it on.
    communityExtensions?: boolean
    // The terminal Open in Terminal uses: 'auto' or absent for the system's, else one of MAC_TERMINALS by id.
    terminal?: string
    // What file links open with: absent for the system's default app, 'custom' for editorCommand, else an EDITORS id.
    editor?: string
    // The user's own command for files, with {file}, {line} and {col}.
    editorCommand?: string
    // The user's edits of extensions' prompts, by extension and prompt id (prompts.ts).
    prompts?: Record<string, Record<string, { text: string; base: string }>>
  }

/** The garage's settings.json, read once; save writes the same object back. Older names are renamed and saved. */
export function openSettings(garage: string) {
  const file = join(garage, 'settings.json')
  const settings: Settings = { engines: {}, ...readJson(file) }
  const save = () => writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
  if (renameSettings(settings)) save()
  return { settings, save }
}

/** Writes a chat's chat.json: its info, and its context switches if any are set. */
export const saveChatFile = (dir: string, info: ChatInfo, context: Record<string, boolean>) => {
  const file = { ...info, ...(Object.keys(context).length ? { context } : {}) }
  writeFileSync(join(dir, 'chat.json'), JSON.stringify(file, null, 2) + '\n')
}

/** Adds one entry to a chat's log.jsonl. */
export const appendEntry = (dir: string, entry: ChatEntry) =>
  appendFileSync(join(dir, 'log.jsonl'), JSON.stringify(entry) + '\n')

/** The ids of the chats stored under chatsDir: each folder with a chat.json. */
export const storedChatIds = (chatsDir: string) =>
  readdirSync(chatsDir).filter((id) => existsSync(join(chatsDir, id, 'chat.json')))

/**
 * A chat's saved files, made if missing. fallback fills what chat.json lacks; declared is an extension's own chat,
 * whose name and extension are its declaration's and which keeps no folders or files. resave says chat.json should be
 * written again: it's new, an extension's, or in an older form.
 */
export const readChat = (dir: string, fallback: ChatInfo, declared?: { name: string; extension: string }) => {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'chat.json')
  const raw = readJson(file)
  const { context = {}, title, parentId, extension, ...saved } = renameChatFile(raw)
  const info: ChatInfo = {
    ...fallback,
    ...(title !== undefined && { name: title }),
    ...saved,
    id: fallback.id,
    ...(saved.worker && parentId !== undefined && { parentId }),
    ...(declared && { name: declared.name, extension: declared.extension, folders: [], files: [] }),
  }
  const logFile = join(dir, 'log.jsonl')
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const entries: ChatEntry[] = log
    .split('\n')
    .filter(Boolean)
    .map((line) => renameEntry(JSON.parse(line)))
  const flipped = 'askNetworkCommands' in raw
  const resave = !existsSync(file) || !!declared || flipped || (parentId !== undefined && !info.parentId)
  return { info, context: context as Record<string, boolean>, entries, resave }
}

/** Whether a chat's log ends inside a turn, as when Kothar quit while it ran. */
export const quitMidTurn = (entries: ChatEntry[]) => {
  const lastTurnEvent = entries.findLast((e) => ['turn.started', 'turn.completed', 'session.ended'].includes(e.type))
  const lastType = entries.at(-1)?.type
  return lastTurnEvent?.type === 'turn.started' || lastType === 'user.message' || lastType === 'worker.report'
}

export const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})
