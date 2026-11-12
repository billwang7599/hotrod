// How agents may write in a chat's attached folders that aren't git repos (git folders are checked out instead,
// checkouts.ts): each has a mode the user picks in the Context panel. Plain functions of plain data, so the sandbox,
// the permission answers and the instructions all read the same folders the same way.
import { realPath } from './machine.ts'
import { secretPathsOf } from './read-only.ts'
import { DEFAULT_FOLDER_MODE, FOLDER_MODES, type ChatInfo, type ContextItem, type FolderMode } from './shared.ts'
import { within } from './util.ts'

export const HOLDS_KOTHAR_DATA = "it holds Kothar's own data, which agents never write"
export const MODE_SETTING = "its mode in the chat's Context panel"

/** A folder of a turn as its session sees it: a mode, or a git folder's checkout. where: the checkout's or copy's path. */
export type FolderPlace = { path: string; mode: FolderMode | 'checkout'; where?: string; blocked?: string }

/** A folder's mode for a chat, from its chain nearest first: its own pick, else the nearest chat above's. */
export const modeOf = (nearestFirst: Pick<ChatInfo, 'folderModes'>[], path: string): FolderMode =>
  nearestFirst.find((info) => info.folderModes?.[path] !== undefined)?.folderModes?.[path] ?? DEFAULT_FOLDER_MODE

/** Why agents may never write in this folder whatever its mode, or undefined: it holds the garage or sits in it. */
export const blockedWhy = (folder: string, garage: string) => {
  const real = realPath(folder)
  const kothar = realPath(garage)
  return within(real, kothar) || within(kothar, real) ? HOLDS_KOTHAR_DATA : undefined
}

export const checkMode = (mode: unknown): FolderMode => {
  if (!FOLDER_MODES.includes(mode as FolderMode)) throw new Error(`Unknown folder mode "${mode}"`)
  return mode as FolderMode
}

/** The turn's folders that aren't git repos, from its context items that are on. A blocked folder is read only. */
export const placesOf = (items: ContextItem[]): FolderPlace[] =>
  items.flatMap(({ section, enabled, git, path, mode = DEFAULT_FOLDER_MODE, blocked }) =>
    section !== 'folders' || !enabled || git ? [] : [{ path, mode: blocked ? 'readOnly' : mode, ...(blocked && { blocked }) }],
  )

export const editableOf = (places: FolderPlace[]) => places.filter((p) => p.mode === 'edit').map((p) => p.path)

/** What a sandbox adds for the folders edited in place: they're writable, but logins and keys inside stay read only. */
export const placeAccess = (places: FolderPlace[], home: string, garage: string) => {
  const writable = editableOf(places)
  const readOnly = secretPathsOf(home, garage).filter((secret) =>
    writable.some((folder) => within(realPath(secret), realPath(folder))),
  )
  return { writable, readOnly }
}

/** The attached folder an absolute real path lies in, if any. */
export const placeOf = (target: string, places: FolderPlace[]) =>
  places.find((place) => within(target, realPath(place.path)))

const MODE_LINES: Record<Exclude<FolderMode, 'copy'>, string> = {
  edit: 'Edit in place. Write in it directly.',
  readOnly: 'Read only.',
}

/** The instructions' list of folders and where to write for each; empty without any. */
export const folderLines = (places: FolderPlace[]) =>
  places.map(({ path, mode, where, blocked }) =>
    mode === 'checkout'
      ? `- ${path}: checked out at ${where}. Write in the checkout.`
      : mode === 'copy'
        ? `- ${path}: Work on a copy. Write only in your copy at ${where}; the user copies your changes back.`
        : `- ${path}: ${blocked ? `Read only, since ${blocked}.` : MODE_LINES[mode]}`,
  )

/** Why an edit at target (an absolute real path) is refused, naming the setting that would allow it. */
export const refusedEditWhy = (target: string, workDir: string, places: FolderPlace[], advice: string) => {
  const editable = editableOf(places).length > 0
  const allowed = `Kothar lets this chat edit only inside ${workDir}${editable ? ' and the folders set to Edit in place' : ''}.`
  const place = placeOf(target, places)
  if (!place) return `${allowed} ${advice}`
  if (place.mode === 'checkout') return `${allowed} ${place.path} is a git folder: edit its checkout at ${place.where} instead.`
  if (place.mode === 'copy') return `${allowed} ${place.path} is set to Work on a copy: edit your copy at ${place.where} instead.`
  if (place.blocked) return `${allowed} ${place.path} can't be edited, since ${place.blocked}.`
  return `${allowed} ${place.path} is set to Read only. Work in the work folder, or ask the user to set the folder to Edit in place (${MODE_SETTING}).`
}
