import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ExtensionHost, ExtensionView } from '@kothar/extension-api'
import { ROLLING_FILE } from './rolling.ts'
import { SUMMARIES_FILE } from './tree.ts'

// Where each memory mode keeps its summaries, and the Settings readout of how much disk they take, with a way to
// delete the mode that isn't in use. Each chat keeps its own file, beside its log, in <garage>/chats/<id>/.

type Mode = 'tree' | 'rolling'

export const MODE_FILES: Record<Mode, string> = { tree: SUMMARIES_FILE, rolling: ROLLING_FILE }
export const MODE_LABELS: Record<Mode, string> = { tree: 'Summary tree', rolling: 'Rolling summary' }
const MODES: Mode[] = ['rolling', 'tree']

// <garage>/chats, from the extension's own storage in <garage>/extensions/<id>/. Every chat folder is there, Home's
// (main) and workers' too, including chats whose extension is off and so aren't listed by host.chats().
export const chatsFolderOf = (host: Pick<ExtensionHost, 'storage'>) => join(dirname(dirname(host.storage.dir)), 'chats')

// The mode's file in each chat folder that has one.
function filesOf(chatsDir: string, mode: Mode) {
  let ids: string[]
  try {
    ids = readdirSync(chatsDir)
  } catch {
    return []
  }
  return ids.flatMap((id) => {
    const path = join(chatsDir, id, MODE_FILES[mode])
    try {
      const stat = lstatSync(path)
      return stat.isFile() ? [{ path, size: stat.size }] : []
    } catch {
      return []
    }
  })
}

export function diskUse(chatsDir: string, mode: Mode) {
  const files = filesOf(chatsDir, mode)
  return { bytes: files.reduce((sum, file) => sum + file.size, 0), chats: files.length }
}

// Removes the mode's file from every chat folder and nothing else. Returns how many it removed.
export function deleteSummaries(chatsDir: string, mode: Mode) {
  const files = filesOf(chatsDir, mode)
  for (const { path } of files) rmSync(path, { force: true })
  return files.length
}

export function formatBytes(bytes: number) {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

const chatsText = (count: number) => `${count} ${count === 1 ? 'chat' : 'chats'}`

// inUse: the mode Memory runs on now, or none while it's off.
export function storageView(chatsDir: string, inUse: Mode | undefined): ExtensionView {
  const modeRow = (mode: Mode): ExtensionView => {
    const { bytes, chats } = diskUse(chatsDir, mode)
    const used = mode === inUse
    const label = MODE_LABELS[mode]
    return {
      type: 'row',
      justify: 'between',
      children: [
        {
          type: 'stack',
          gap: 'tight',
          children: [
            {
              type: 'row',
              children: [
                { type: 'text', text: label },
                ...(used ? [{ type: 'badge' as const, text: 'In use', tone: 'accent' as const }] : []),
              ],
            },
            { type: 'text', text: join('<id>', MODE_FILES[mode]), mono: true, tone: 'muted' },
            {
              type: 'text',
              small: true,
              tone: 'muted',
              text: chats ? `${formatBytes(bytes)} in ${chatsText(chats)}` : 'No files',
            },
          ],
        },
        {
          type: 'button',
          label: 'Delete summaries',
          action: { name: 'delete', value: mode },
          disabled: used || !chats,
          hint: used
            ? `Memory uses these now. Switch Older messages to the other mode, or turn Memory off, to delete them.`
            : `Deletes ${MODE_FILES[mode]} from every chat folder. Chat logs stay.`,
          confirm: {
            text: `Delete the ${label} files of ${chatsText(chats)}?`,
            body:
              `This frees ${formatBytes(bytes)}. Chat logs stay. If you switch Memory back to ${label}, ` +
              'Kothar writes these summaries again with model calls on your logins.',
            ok: 'Delete summaries',
            danger: true,
          },
        },
      ],
    }
  }
  return {
    type: 'stack',
    gap: 'normal',
    children: [
      {
        type: 'heading',
        text: 'Storage',
        hint:
          "Each chat keeps its summaries in its own folder, beside its log. Switching modes or turning Memory off " +
          'deletes nothing, and deleting a chat deletes its summaries.',
      },
      { type: 'text', text: chatsDir, mono: true, copy: true, hint: 'The chats folder. Each chat has a folder here, named by its id.' },
      ...MODES.flatMap((mode): ExtensionView[] => [{ type: 'divider' }, modeRow(mode)]),
    ],
  }
}
