import type { AccountStatus, Adapter, Machine, ToolKind } from '../types.ts'

const KINDS: Record<string, ToolKind> = {
  Bash: 'shell',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
}

const SUMMARY_FIELDS: Partial<Record<ToolKind, string[]>> = {
  shell: ['command'],
  edit: ['file_path', 'notebook_path'],
  read: ['file_path'],
  search: ['pattern', 'query'],
  fetch: ['url', 'query'],
}

const OUTPUT_TAIL_CHARS = 2000
// The login prints its manual sign-in link inside an OSC 8 hyperlink, ended by BEL or ESC.
const LOGIN_URL = /https:\/\/[^\s\x07\x1b]+(?=[\s\x07\x1b])/
const ANSI = /\x1b\][^\x07]*\x07|\x1b\[[0-9;]*[A-Za-z]/g

// Each account is its own config folder; Claude Code keys its keychain login by that folder's path.
const accountEnv = (accountDir?: string, apiKey?: string) =>
  accountDir ? { env: { CLAUDE_CONFIG_DIR: accountDir, ...(apiKey && { ANTHROPIC_API_KEY: apiKey }) } } : {}

async function authStatus(machine: Machine, accountDir?: string): Promise<AccountStatus> {
  const options = { cwd: '/', ...accountEnv(accountDir) }
  const auth = await machine.run('claude', ['auth', 'status'], options).catch(() => null)
  try {
    const status = JSON.parse(auth?.stdout ?? '')
    return { signedIn: status.loggedIn === true, ...(typeof status.email === 'string' && { label: status.email }) }
  } catch {
    return { signedIn: false }
  }
}

const kindOf = (name: string): ToolKind => (name.startsWith('mcp__') ? 'mcp' : (KINDS[name] ?? 'other'))

function summarize(kind: ToolKind, input: any): string {
  const picked = SUMMARY_FIELDS[kind]?.map((key) => input?.[key]).find((value) => typeof value === 'string')
  return (picked ?? JSON.stringify(input) ?? '').replace(/\s+/g, ' ').trim()
}

export const claudeCode: Adapter = {
  id: 'claude-code',

  async detect(machine) {
    const options = { cwd: '/' }
    const version = await machine.run('claude', ['--version'], options).catch(() => null)
    if (version?.code !== 0) return { installed: false, signedIn: false }
    const { signedIn } = await authStatus(machine)
    return { installed: true, signedIn, detail: version.stdout.trim() }
  },

  accounts: {
    status: authStatus,

    login(machine, accountDir, emit) {
      const options = { cwd: accountDir, ...accountEnv(accountDir) }
      const proc = machine.spawn('claude', ['auth', 'login', '--claudeai'], options)
      let output = ''
      let sentUrl = false
      const collect = (chunk: string) => {
        output = (output + chunk).slice(-OUTPUT_TAIL_CHARS)
        const url = !sentUrl && output.match(LOGIN_URL)?.[0]
        if (!url) return
        sentUrl = true
        emit({ type: 'url', url })
      }
      proc.onStdout(collect)
      proc.onExit((code, stderrTail) => {
        if (code === 0) return emit({ type: 'done' })
        const text = (output + stderrTail).replace(ANSI, '')
        const error = text.match(/Login failed:.*/)?.[0] ?? `Claude Code sign-in exited with code ${code}`
        emit({ type: 'failed', error: error.trim() })
      })
      return {
        submitCode: (code) => proc.write(code.trim() + '\n'),
        cancel: () => proc.kill(),
      }
    },

    async logout(machine, accountDir) {
      await machine.run('claude', ['auth', 'logout'], { cwd: '/', ...accountEnv(accountDir) })
    },

    apiKeys: true,
  },

  start(machine, { cwd, instructions, accountDir, apiKey }, emit) {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--no-session-persistence',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--settings', '{"autoMemoryEnabled":false}',
      // Headless Claude Code omits thinking text unless asked; the flag is hidden from --help.
      '--thinking-display', 'summarized',
    ]
    if (instructions) args.push('--append-system-prompt', instructions)
    const proc = machine.spawn('claude', args, { cwd, ...accountEnv(accountDir, apiKey) })
    const send = (message: unknown) => proc.write(JSON.stringify(message) + '\n')
    const pendingInputs = new Map<string, unknown>()
    let buffer = ''
    let interrupted = false
    let closed = false
    let exited = false
    let interruptCount = 0

    const handle = (msg: any) => {
      const subagent = msg.parent_tool_use_id != null
      switch (msg.type) {
        case 'stream_event': {
          const delta = msg.event?.delta
          if (subagent) return
          if (delta?.type === 'text_delta') emit({ type: 'text.delta', text: delta.text })
          if (delta?.type === 'thinking_delta' && delta.thinking) emit({ type: 'thinking.delta', text: delta.thinking })
          return
        }
        case 'assistant':
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && !subagent) emit({ type: 'text.completed', text: block.text })
            if (block.type === 'tool_use') {
              const kind = kindOf(block.name)
              const summary = summarize(kind, block.input)
              emit({ type: 'tool.started', toolId: block.id, name: block.name, kind, summary, input: block.input })
            }
          }
          return
        case 'user':
          if (!Array.isArray(msg.message?.content)) return
          for (const block of msg.message.content) {
            if (block.type !== 'tool_result') continue
            const output =
              typeof block.content === 'string'
                ? block.content
                : (block.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
            emit({ type: 'tool.completed', toolId: block.tool_use_id, output, isError: block.is_error === true })
          }
          return
        case 'control_request': {
          const request = msg.request ?? {}
          if (request.subtype !== 'can_use_tool') {
            // Claude Code waits forever on an unanswered control request.
            send({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'Unsupported' } })
            return
          }
          pendingInputs.set(msg.request_id, request.input)
          const kind = kindOf(request.tool_name)
          emit({
            type: 'permission.requested',
            requestId: msg.request_id,
            ...(request.tool_use_id ? { toolId: request.tool_use_id } : {}),
            name: request.tool_name,
            kind,
            summary: summarize(kind, request.input),
            input: request.input,
          })
          return
        }
        case 'result': {
          const error = interrupted
            ? 'Interrupted'
            : msg.is_error
              ? msg.result || msg.errors?.join('\n') || msg.subtype || 'Claude Code failed'
              : undefined
          interrupted = false
          emit(error ? { type: 'turn.completed', error } : { type: 'turn.completed' })
        }
      }
    }

    proc.onStdout((chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        handle(msg)
      }
    })
    proc.onExit((code, stderrTail) => {
      exited = true
      if (code === 0 || closed) return emit({ type: 'session.ended' })
      emit({ type: 'session.ended', error: stderrTail.trim() || `Claude Code exited with code ${code}` })
    })

    return {
      prompt(text) {
        send({ type: 'user', message: { role: 'user', content: text } })
        emit({ type: 'turn.started' })
      },
      interrupt() {
        interrupted = true
        send({ type: 'control_request', request_id: `interrupt-${++interruptCount}`, request: { subtype: 'interrupt' } })
      },
      respond(requestId, allow) {
        if (!pendingInputs.has(requestId)) return
        const input = pendingInputs.get(requestId)
        pendingInputs.delete(requestId)
        const response = allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'The user denied this tool call.' }
        send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
      },
      close() {
        closed = true
        proc.closeStdin()
        if (!exited) proc.kill()
      },
    }
  },
}
