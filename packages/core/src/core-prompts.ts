// Kothar's own named prompts, the ones that aren't an extension's or Settings → Workers': each one's default, the
// user's edit if any (settings.json corePrompts, with the default it was made against), and the text agents are sent.
// Settings → Prompts edits them; the Inspector's "What was sent" labels each and links here.
import type { Settings } from './chat-store.ts'
import { MAX_PROMPT_CHARS, type PromptEdit } from './prompts.ts'
import type { CoreMessage, PromptInfo } from './shared.ts'

export const COMBINE_TEXT =
  'What you can use, from Kothar and from the extensions the user turned on, is listed below. They work together: ' +
  'when a task needs more than one, combine them on your own, without being asked. For example, hand a deep research ' +
  'run to a worker so you keep talking with the user while it runs, have a worker save what it finds as a note or an ' +
  'artifact, or check a page in the browser before you write about it. A worker gets the same tools you have, apart ' +
  'from starting workers of its own.'

export const CORE_PROMPTS: readonly (Omit<PromptInfo, 'text' | 'default' | 'edited' | 'updatedDefault'> & { text: string })[] = [
  {
    id: 'combine',
    label: 'What you can use',
    where: 'instructions',
    description: 'Comes before the list of what this chat can use: Kothar’s tools and each extension’s, made from their names and descriptions.',
    text: COMBINE_TEXT,
  },
]

// Where Settings shows a core prompt, as a kothar:settings/<this> link opens it.
export const corePromptLink = (id: string) => `prompts#prompt-kothar-${id}`

export function openCorePrompts({ settings, saveSettings, broadcast }: { settings: Settings; saveSettings: () => void; broadcast: (message: CoreMessage) => void }) {
  const declared = (id: string) => {
    const prompt = CORE_PROMPTS.find((p) => p.id === id)
    if (!prompt) throw new Error(`Kothar has no prompt "${id}"`)
    return prompt
  }
  const editOf = (id: string): PromptEdit | undefined => {
    const edit = settings.corePrompts?.[id]
    return edit && typeof edit.text === 'string' && typeof edit.base === 'string' ? edit : undefined
  }
  const textOf = (id: string) => editOf(id)?.text ?? declared(id).text
  const info = (): PromptInfo[] =>
    CORE_PROMPTS.map(({ text, ...prompt }) => {
      const edit = editOf(prompt.id)
      return {
        ...prompt,
        default: text,
        text: edit?.text ?? text,
        ...(edit && { edited: true as const }),
        ...(edit && edit.base !== text && { updatedDefault: true as const }),
      }
    })
  // text undefined (or blank, or the default itself): back to the default.
  const set = (id: unknown, text: unknown) => {
    const { text: fallback } = declared(String(id))
    if (text !== undefined && typeof text !== 'string') throw new Error('A prompt is text')
    if (typeof text === 'string' && text.length > MAX_PROMPT_CHARS) throw new Error(`A prompt is at most ${MAX_PROMPT_CHARS} characters`)
    const own = { ...settings.corePrompts }
    if (text === undefined || text === fallback || !text.trim()) delete own[String(id)]
    else own[String(id)] = { text, base: fallback }
    if (Object.keys(own).length) settings.corePrompts = own
    else delete settings.corePrompts
    saveSettings()
    broadcast({ type: 'corePrompts.updated', prompts: info() })
  }
  return { textOf, info, set }
}

export type CorePrompts = ReturnType<typeof openCorePrompts>

// One line of "What you can use": a group of tools, from Kothar or one extension, and what it's for.
export type ToolboxGroup = { name: string; about: string; tools: string[] }

const ABOUT_CHARS = 160

// What an extension's description says first: its first sentence, cut to a line.
export const firstSentence = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  const end = flat.search(/[.!?](\s|$)/)
  const sentence = end < 0 ? flat : flat.slice(0, end + 1)
  return sentence.length > ABOUT_CHARS ? `${sentence.slice(0, ABOUT_CHARS - 1).trimEnd()}…` : sentence
}

/** The "What you can use" section: the intro (the user's edit of COMBINE_TEXT), then one line per group. */
export const toolboxText = (intro: string, groups: ToolboxGroup[]) =>
  [intro.trim(), '', ...groups.map((g) => `- ${g.name} (${g.tools.join(', ')})${g.about ? `: ${g.about}` : ''}`)].join('\n')
