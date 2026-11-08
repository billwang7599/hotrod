export type ModSetting = { key: string; label: string; description?: string } & (
  | { type: 'select'; options: { value: string | number; label: string }[]; default: string | number }
  | { type: 'number'; default: number; min?: number; max?: number; integer?: boolean }
  | { type: 'boolean'; default: boolean }
)

export type ModValues = Record<string, string | number | boolean>

export type ChatSummary = { id: string; name: string; engine: string; parentId?: string; subagent?: boolean }

// A mod's chat is pinned, can't be renamed, archived or deleted, and keeps no folders, files or AGENTS.md of its own.
export type ModChat = { id: string; name: string; instructions: string; seesAll?: boolean }

export type ModHost = {
  createChat(spec: { name: string; folders?: string[]; files?: string[]; engine?: string }): { id: string }
  send(chatId: string, text: string): void
}

export type ModTool = {
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[] }
  offered(caller: ChatSummary): boolean
  run(input: Record<string, unknown>, call: { caller: ChatSummary; values: ModValues; host: ModHost }): unknown
}

export type McpServer = {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  allowTools?: boolean
}

export type ModSession = { chat: ChatSummary; workDir: string; sandboxed: boolean; values: ModValues }

export type Mod = {
  id: string
  name: string
  description: string
  enabledByDefault: boolean
  settings?: ModSetting[]
  chats?: ModChat[]
  tools?: ModTool[]
  mcpServers?(session: ModSession): McpServer[]
}
