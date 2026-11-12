// Joins a session's instructions from plain data, in the README's order (Instructions). The core gathers each part
// (asking extensions, reading files) and this only orders and formats them, so it can be tested alone.
import { folderLines, type FolderPlace } from './folder-modes.ts'
import type { ContextItem } from './shared.ts'

export const WRITE_RULES =
  'You can write files only in your work folder and in attached folders set to Edit in place. Every other folder ' +
  'is read-only to you: writes there fail.'
export const FOLDER_RULES =
  "The user sets how you may write in each attached folder that isn't a git repo, as its mode in the chat's " +
  "Context panel. To write in one you can't, ask them to change its mode there:"
export const CHECKOUT_RULES =
  'Each git folder in your context is checked out in your work folder on a branch of its own, from its last ' +
  "commit, so changes the user hasn't committed aren't in it. Work and commit in the checkout:"

export type InstructionCheckout = { folder: string; path: string; branch: string }

export type InstructionParts = {
  // An extension's own chat (Home) gets its extension's role instructions first.
  role?: string
  // Set while sandboxed: the chat may write only here.
  workDir?: string
  checkouts: InstructionCheckout[]
  // The attached folders that aren't git repos, each with its mode.
  folders: FolderPlace[]
  // What extensions add (Extension.instructions), already trimmed, in extension order.
  extensions: string[]
  // The Workers extension's instructions, for a chat that may start workers.
  workers?: string
  // The memory extension's instructions, already trimmed.
  memory: string[]
  // A worker's view of its parent's memory, frozen at launch.
  parentView?: string
  setup?: { name: string; instructions?: string }
  // The chat's context items, in order; only enabled ones count.
  items: ContextItem[]
}

// A context item as the session sees it: a file pasted in full and tagged, other items as they are.
export const contextTextOf = (items: ContextItem[]) =>
  items.flatMap(({ enabled, section, path, text, binary }) => {
    if (!enabled) return []
    if (binary) return [`The file ${path} is not text, so it isn't pasted here. Open it with your tools when you need it.`]
    if (!text.trim()) return []
    return [section === 'files' ? `<file path="${path}">\n${text.trimEnd()}\n</file>` : text.trim()]
  })

export const buildInstructions = (parts: InstructionParts) => {
  const { role, workDir, checkouts, folders, extensions, workers, memory, parentView, setup, items } = parts
  const rules = [
    ...(workDir !== undefined ? [`${WRITE_RULES}\nYour work folder: ${workDir}`] : []),
    ...(checkouts.length
      ? [[CHECKOUT_RULES, ...checkouts.map((c) => `- ${c.folder}: ${c.path} (branch ${c.branch})`)].join('\n')]
      : []),
    ...(folders.length ? [[FOLDER_RULES, ...folderLines(folders)].join('\n')] : []),
  ]
  const memoryText = [
    ...(workers !== undefined ? [workers] : []),
    ...memory,
    ...(parentView ? [`Your parent chat's memory when it started you:\n\n${parentView}`] : []),
  ]
  // The setup's instructions come just before the context items, so the user's own AGENTS.md files read last.
  const setupText = setup?.instructions ? [`Instructions from the setup "${setup.name}":\n\n${setup.instructions}`] : []
  return [...(role ? [role] : []), ...rules, ...extensions, ...memoryText, ...setupText, ...contextTextOf(items)].join(
    '\n\n',
  )
}
