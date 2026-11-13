// What a turn was sent, labelled for the Inspector (Extension.onTurnSent): turn.ts hands on the raw parts as the
// session opens (SentInput), and this names who each part is from, which of an extension's prompts it carries and
// whether the user edited them, the tools offered, how the turn runs, and what the engine adds that Kothar can't see.
import type { ChatSummary, Extension, SentSection, SentTurn } from '@kothar/extension-api'
import type { PromptPart } from './memory.ts'
import { TOOL_PROMPT } from './prompts.ts'
import type { PromptInfo } from './shared.ts'
import type { SentInput } from './turn.ts'

// A tool a session is offered over Kothar's MCP server: the core's own (no extension) or an extension's.
export type SentTool = { name: string; description: string; schema: unknown; extension?: string }

export type SentDeps = {
  extension: (id: string) => Extension | undefined
  promptsOf: (extension: Extension) => PromptInfo[]
  engineName: (engine: string) => string
  // The memory extension's id for this chat, if one is on (else the core's window is the memory).
  memoryOf: (chatId: string) => string | undefined
  // Tools only when the session gets Kothar's MCP server.
  toolsOf: (chatId: string) => SentTool[]
}

export function sentTurnOf(chat: ChatSummary, at: string, id: string, input: SentInput, deps: SentDeps): SentTurn {
  const engine = deps.engineName(input.engine)
  const base = { id, turn: input.turn, chat, at, engine: input.engine }
  if (input.kind === 'steer') {
    const sections: SentSection[] = [{ source: 'you', part: 'prompt', label: 'You, steered into the running turn', text: input.text }]
    return { ...base, kind: 'steer', continued: false, sections }
  }
  const nameOf = (id: string | undefined) => (id && deps.extension(id)?.name) ?? id ?? 'Kothar'
  const promptsFor = (id: string, where: PromptInfo['where'], tool?: string) => {
    const extension = deps.extension(id)
    if (!extension) return []
    return deps
      .promptsOf(extension)
      .filter((prompt) => prompt.where === where && (tool === undefined || prompt.tool === tool))
      .map((prompt) => ({ id: prompt.id, label: prompt.label, edited: prompt.edited === true }))
  }
  const sections: SentSection[] = []
  for (const section of input.instructions) {
    if (section.source !== 'extension' || !section.extension) {
      // Core text the user can change (Settings → Workers) links to where.
      const { settings } = section
      sections.push({ source: section.source, part: 'instructions', label: section.label, text: section.text, ...(settings && { settings, editable: true }) })
      continue
    }
    const id = section.extension
    const prompts = promptsFor(id, 'instructions')
    const editable = prompts.length > 0
    sections.push({
      source: 'extension',
      part: 'instructions',
      label: `${nameOf(id)}: ${section.label.toLowerCase()}${editable ? '' : ' (not editable)'}`,
      text: section.text,
      extension: id,
      extensionName: nameOf(id),
      ...(prompts.length && { prompts }),
      editable,
    })
  }
  const memory = deps.memoryOf(chat.id)
  for (const part of input.prompt) sections.push(promptSection(part, input, memory, nameOf, promptsFor))
  if (input.kotharMcp) {
    for (const tool of deps.toolsOf(chat.id)) {
      const prompts = tool.extension ? promptsFor(tool.extension, 'tool', tool.name) : []
      sections.push({
        source: 'tools',
        part: 'other',
        label: `${tool.extension ? nameOf(tool.extension) : 'Kothar'} tool: ${tool.name}`,
        text: `${tool.description}\n\nInput: ${JSON.stringify(tool.schema)}`,
        ...(tool.extension && {
          extension: tool.extension,
          extensionName: nameOf(tool.extension),
          prompts,
          editable: prompts.some((p) => p.id === TOOL_PROMPT + tool.name),
        }),
      })
    }
  }
  for (const server of input.mcpServers) {
    sections.push({
      source: 'engine',
      part: 'other',
      label: `MCP server "${server}": its tools, not visible to Kothar`,
      text: `An extension started the MCP server "${server}" for this session. The engine asks it for its tools and their descriptions itself, so Kothar doesn't see them.`,
    })
  }
  sections.push({ source: 'turn', part: 'other', label: 'How this turn runs', text: howItRuns(input, engine, nameOf) })
  sections.push({
    source: 'engine',
    part: 'other',
    label: `Added by ${engine}, not visible to Kothar`,
    text:
      `${engine} adds its own system prompt, its built-in tools and their descriptions on top of everything above, ` +
      "and may add more as the turn goes (such as tool results and its own reminders). Kothar can't see that part.",
  })
  return { ...base, kind: 'turn', ...(input.model && { model: input.model }), ...(input.account && { account: input.account }), continued: input.continued, sections }
}

function promptSection(
  part: PromptPart,
  input: Extract<SentInput, { kind: 'turn' }>,
  memory: string | undefined,
  nameOf: (id: string | undefined) => string,
  promptsFor: (id: string, where: PromptInfo['where']) => { id: string; label: string; edited: boolean }[],
): SentSection {
  if (part.kind === 'view') {
    if (!memory) return { source: 'core', part: 'prompt', label: 'Memory: the conversation so far (Kothar’s window)', text: part.text }
    const prompts = promptsFor(memory, 'message')
    return {
      source: 'extension',
      part: 'prompt',
      label: `${nameOf(memory)}: the conversation so far`,
      text: part.text,
      extension: memory,
      extensionName: nameOf(memory),
      ...(prompts.length && { prompts }),
      editable: prompts.length > 0,
    }
  }
  if (part.kind === 'report') return { source: 'core', part: 'prompt', label: 'A worker’s report', text: part.text }
  if (part.kind === 'kothar') return { source: 'core', part: 'prompt', label: 'From Kothar, carrying on the turn', text: part.text }
  const images = input.images ? `, with ${input.images} image${input.images === 1 ? '' : 's'} sent alongside` : ''
  return {
    source: 'you',
    part: 'prompt',
    label: `You${input.rewritten ? ' (rewritten by an extension on its way)' : ''}${images}`,
    text: part.text,
  }
}

function howItRuns(input: Extract<SentInput, { kind: 'turn' }>, engine: string, nameOf: (id: string | undefined) => string) {
  const { model, thinking, account, sandboxed, readOnly, role, continued } = input
  return [
    `Engine: ${engine}`,
    `Model: ${model ?? 'the engine’s default'}${thinking ? `, thinking ${thinking}` : ''}`,
    ...(account ? [`Account: ${account}`] : []),
    ...(role ? [`Model list: ${role.role}, picked by ${nameOf(role.by)}${role.used ? '' : ' (empty, so the chat’s own model ran)'}`] : []),
    `Sandbox: ${sandboxed ? 'on' : 'off (edits anywhere)'}`,
    ...(readOnly ? [`Read only: yes, set by ${nameOf(readOnly.by)}${readOnly.reason ? `: ${readOnly.reason}` : ''}`] : []),
    ...(continued ? ['Continues the last turn (a prompt from Kothar, not a message of yours)'] : []),
  ].join('\n')
}
