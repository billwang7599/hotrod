export type ToolKind = 'shell' | 'edit' | 'read' | 'search' | 'fetch' | 'mcp' | 'other'

export type EngineEvent =
  | { type: 'turn.started' }
  | { type: 'text.delta'; text: string }
  | { type: 'text.completed'; text: string }
  | { type: 'tool.started'; toolId: string; name: string; kind: ToolKind; summary: string; input: unknown }
  | { type: 'tool.completed'; toolId: string; output: string; isError: boolean }
  | {
      type: 'permission.requested'
      requestId: string
      toolId?: string
      name: string
      kind: ToolKind
      summary: string
      input: unknown
    }
  | { type: 'turn.completed'; error?: string }
  | { type: 'session.ended'; error?: string }

export interface EngineProcess {
  write(data: string): void
  closeStdin(): void
  kill(): void
  onStdout(listener: (chunk: string) => void): void
  onStderr(listener: (chunk: string) => void): void
  onExit(listener: (code: number | null) => void): void
}

export interface Machine {
  spawn(command: string, args: string[], options: { cwd: string; env?: Record<string, string> }): EngineProcess
  run(
    command: string,
    args: string[],
    options: { cwd: string; env?: Record<string, string> },
  ): Promise<{ code: number | null; stdout: string; stderr: string }>
}

export type EngineStatus = { installed: boolean; signedIn: boolean; detail?: string }

export type EngineInfo = { id: string } & EngineStatus

export type SessionOptions = { cwd: string; instructions: string }

export interface Session {
  prompt(text: string): void
  interrupt(): void
  respond(requestId: string, allow: boolean): void
  close(): void
}

export interface Adapter {
  id: string
  detect(machine: Machine): Promise<EngineStatus>
  start(machine: Machine, options: SessionOptions, emit: (event: EngineEvent) => void): Session
}

export type Project = { id: string; name: string; path: string; engine: string }

export type ChatStatus = 'idle' | 'running' | 'waiting'

export type ChatEntry = { at: string } & (
  | { type: 'user.message'; text: string }
  | { type: 'permission.resolved'; requestId: string; allow: boolean }
  | Exclude<EngineEvent, { type: 'text.delta' }>
)

export type ProjectState = Project & { status: ChatStatus; entries: ChatEntry[]; draft: string }

export type ClientMessage =
  | { type: 'project.add'; path: string }
  | { type: 'project.setEngine'; projectId: string; engine: string }
  | { type: 'chat.send'; projectId: string; text: string }
  | { type: 'chat.interrupt'; projectId: string }
  | { type: 'permission.respond'; projectId: string; requestId: string; allow: boolean }

export type CoreMessage =
  | { type: 'snapshot'; engines: EngineInfo[]; projects: ProjectState[] }
  | { type: 'project.added'; project: ProjectState }
  | { type: 'project.updated'; project: Project }
  | { type: 'chat.entry'; projectId: string; entry: ChatEntry }
  | { type: 'chat.delta'; projectId: string; text: string }
  | { type: 'chat.status'; projectId: string; status: ChatStatus }
  | { type: 'error'; message: string }
