// Extensions' named prompts (Extension.prompts) and their tools' descriptions: each one's default, the user's edit if
// any (saved in settings.json under prompts, with the default it was made against), and the text agents are sent.
import type { Extension, ExtensionPrompt, ExtensionTool } from '@kothar/extension-api'
import type { Settings } from './chat-store.ts'
import type { PromptInfo } from './shared.ts'

export const TOOL_PROMPT = 'tool:'
const PROMPT_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const MAX_PROMPT_CHARS = 100_000

// An edit: the text the user wrote, and the default it replaced, so a later default shows as updated.
export type PromptEdit = { text: string; base: string }

// The prompts an extension declares that are fit to use: a bad id, a missing label or text, or a repeat is skipped.
export function declaredPrompts(extension: Extension): ExtensionPrompt[] {
  const seen = new Set<string>()
  return (Array.isArray(extension.prompts) ? extension.prompts : []).filter((prompt) => {
    const fit =
      typeof prompt?.id === 'string' &&
      PROMPT_ID.test(prompt.id) &&
      typeof prompt.label === 'string' &&
      typeof prompt.text === 'string' &&
      (prompt.where === 'instructions' || prompt.where === 'message') &&
      !seen.has(prompt.id)
    if (fit) seen.add(prompt.id)
    return fit
  })
}

const toolsOf = (extension: Extension): ExtensionTool[] =>
  (extension.tools ?? []).filter((tool) => typeof tool?.name === 'string' && typeof tool.description === 'string')

export type PromptsDeps = {
  settings: Settings
  saveSettings: () => void
  // The extension's page changed: its prompts' state is sent again.
  changed: (extension: Extension) => void
}

export function openPrompts({ settings, saveSettings, changed }: PromptsDeps) {
  const editOf = (extension: Extension, id: string): PromptEdit | undefined => {
    const edit = settings.prompts?.[extension.id]?.[id]
    return edit && typeof edit.text === 'string' && typeof edit.base === 'string' ? edit : undefined
  }
  const defaultOf = (extension: Extension, id: string) => {
    if (id.startsWith(TOOL_PROMPT)) return toolsOf(extension).find((tool) => tool.name === id.slice(TOOL_PROMPT.length))?.description
    return declaredPrompts(extension).find((prompt) => prompt.id === id)?.text
  }
  // The text agents get: the user's edit, else the default.
  const textOf = (extension: Extension, id: string) => {
    const fallback = defaultOf(extension, id)
    if (fallback === undefined) throw new Error(`${extension.name} has no prompt "${id}"`)
    return editOf(extension, id)?.text ?? fallback
  }
  const edited = (extension: Extension, id: string) => editOf(extension, id) !== undefined
  // A tool as agents see it: its description as the user left it.
  const toolAsSent = (extension: Extension, tool: ExtensionTool): ExtensionTool => {
    const edit = editOf(extension, TOOL_PROMPT + tool.name)
    return edit ? { ...tool, description: edit.text } : tool
  }
  const infoOf = (extension: Extension): PromptInfo[] => {
    const info = (id: string, label: string, where: PromptInfo['where'], fallback: string, more: Partial<PromptInfo>): PromptInfo => {
      const edit = editOf(extension, id)
      return {
        id,
        label,
        where,
        default: fallback,
        text: edit?.text ?? fallback,
        ...more,
        ...(edit && { edited: true as const }),
        ...(edit && edit.base !== fallback && { updatedDefault: true as const }),
      }
    }
    return [
      ...declaredPrompts(extension).map(({ id, label, where, text, description }) =>
        info(id, label, where, text, description ? { description } : {}),
      ),
      ...toolsOf(extension).map((tool) =>
        info(TOOL_PROMPT + tool.name, `Tool description: ${tool.name}`, 'tool', tool.description, { tool: tool.name }),
      ),
    ]
  }
  // text undefined (or the default itself): back to the default.
  const set = (extension: Extension, id: string, text: string | undefined) => {
    const fallback = defaultOf(extension, id)
    if (fallback === undefined) throw new Error(`${extension.name} has no prompt "${id}"`)
    if (text !== undefined && typeof text !== 'string') throw new Error('A prompt is text')
    if (text !== undefined && text.length > MAX_PROMPT_CHARS) throw new Error(`A prompt is at most ${MAX_PROMPT_CHARS} characters`)
    const own = { ...settings.prompts?.[extension.id] }
    if (text === undefined || text === fallback) delete own[id]
    else own[id] = { text, base: fallback }
    const prompts = { ...settings.prompts }
    if (Object.keys(own).length) prompts[extension.id] = own
    else delete prompts[extension.id]
    if (Object.keys(prompts).length) settings.prompts = prompts
    else delete settings.prompts
    saveSettings()
    changed(extension)
  }
  return { textOf, edited, toolAsSent, infoOf, set }
}

export type Prompts = ReturnType<typeof openPrompts>
