import { homedir } from 'node:os'
import { join } from 'node:path'
import { type AccountStatus, type Adapter, type Machine, type Question, type Sandbox, type ToolKind } from '../shared.ts'

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

// Claude Code has no list command, so these are the ids it accepts.
const MODELS = [
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-5-5',
  'claude-haiku-4-5',
]
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// What Claude Code runs with no flags on a claude.ai or API login (code.claude.com/docs/en/model-config).
const DEFAULTS = { defaultModel: 'claude-opus-5-5', defaultThinking: 'medium' }

const CLEAN_ARGS = [
  '--no-session-persistence',
  '--setting-sources', '',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--settings', '{"autoMemoryEnabled":false,"attribution":false}',
]

const DECLINED = 'The user declined to answer.'
// An error result that means the account is out of usage; older versions add `|<reset epoch>` to the first.
const LIMIT_ERROR = /usage limit reached|hit your (?:[\w-]+ )?limit|rate[_ ]limit|out of (?:extra )?usage/i
const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
}
const OUTPUT_TAIL_CHARS = 2000
// Anthropic's API refuses an image whose base64 is over 5 MB; the prompt still names it by path.
export const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024
// The login prints its manual sign-in link inside an OSC 8 hyperlink, ended by BEL or ESC.
const LOGIN_URL = /https:\/\/[^\s\x07\x1b]+(?=[\s\x07\x1b])/
const ANSI = /\x1b\][^\x07]*\x07|\x1b\[[0-9;]*[A-Za-z]/g

// Each account is its own config folder; Claude Code keys its keychain login by that folder's path.
const accountEnv = (accountDir?: string, apiKey?: string): { env?: Record<string, string> } =>
  accountDir ? { env: { CLAUDE_CONFIG_DIR: accountDir, ...(apiKey && { ANTHROPIC_API_KEY: apiKey }) } } : {}

// Claude Code ignores TMPDIR, and needs its shell snapshots for Bash and the keychain to save a refreshed login.
function jailed(sandbox: Sandbox, accountDir?: string) {
  const configDir = accountDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const keychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db*')
  return {
    sandbox: { ...sandbox, writable: [...sandbox.writable, join(configDir, 'shell-snapshots'), keychain] },
    env: sandbox.tmpDir ? { CLAUDE_CODE_TMPDIR: sandbox.tmpDir } : undefined,
  }
}

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

// Claude Code gives resets in seconds since the epoch.
const isoOf = (epoch: unknown) => {
  const seconds = Number(epoch)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return new Date(seconds < 1e12 ? seconds * 1000 : seconds).toISOString()
}

const kindOf = (name: string): ToolKind => (name.startsWith('mcp__') ? 'mcp' : (KINDS[name] ?? 'other'))

const questionsOf = (input: any): Question[] =>
  (input?.questions ?? []).map((q: any) => ({
    header: String(q.header ?? ''),
    question: String(q.question ?? ''),
    options: (q.options ?? []).map((o: any) => ({
      label: String(o.label ?? ''),
      description: String(o.description ?? ''),
    })),
    multiSelect: q.multiSelect === true,
  }))

function summarize(kind: ToolKind, input: any): string {
  const picked = SUMMARY_FIELDS[kind]?.map((key) => input?.[key]).find((value) => typeof value === 'string')
  return (picked ?? JSON.stringify(input) ?? '').replace(/\s+/g, ' ').trim()
}

export const claudeCode: Adapter = {
  id: 'claude-code',
  imageInput: true,
  hotrodMcp: true,

  async detect(machine) {
    const options = { cwd: '/' }
    const version = await machine.run('claude', ['--version'], options).catch(() => null)
    if (version?.code !== 0) return { installed: false, signedIn: false }
    const { signedIn } = await authStatus(machine)
    const detail = version.stdout.trim()
    const offers = { models: MODELS, thinking: EFFORTS, ...DEFAULTS }
    return { installed: true, signedIn, detail, ...offers }
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

  async complete(machine, { cwd, system, prompt, schema, model, timeoutMs, accountDir, apiKey, sandbox }) {
    const args = ['-p', ...CLEAN_ARGS, '--tools', '', '--output-format', 'json', '--model', model]
    args.push('--system-prompt', system)
    if (schema) args.push('--json-schema', JSON.stringify(schema))
    const jail = sandbox && jailed(sandbox, accountDir)
    const env = { ...accountEnv(accountDir, apiKey).env, ...jail?.env }
    const options = {
      cwd,
      input: prompt,
      timeoutMs,
      ...(Object.keys(env).length && { env }),
      ...(jail && { sandbox: jail.sandbox }),
    }
    const { code, stdout, stderr } = await machine.run('claude', args, options)
    let reply: any
    try {
      reply = JSON.parse(stdout)
    } catch {}
    if (code !== 0 || !reply || reply.is_error) {
      throw new Error(reply?.result || stderr.trim() || `Claude Code exited with code ${code}`)
    }
    return reply.structured_output === undefined ? String(reply.result ?? '') : JSON.stringify(reply.structured_output)
  },

  start(machine, options, emit) {
    const { cwd, instructions, accountDir, apiKey, hotrodMcp, mcpServers = [], extraDirs = [], readFiles = [] } =
      options
    const { model, thinking, sandbox } = options
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      ...CLEAN_ARGS,
      // Headless Claude Code omits thinking text unless asked; the flag is hidden from --help.
      '--thinking-display', 'summarized',
      // Claude Code's own subagents run out of sight, where the user can't open or stop them; Hotrod's
      // spawn_subagent replaces them. `Task` is the tool's name before Claude Code 2.1.
      '--disallowedTools', 'Agent', 'Task',
    ]
    if (model) args.push('--model', model)
    if (thinking) args.push('--effort', thinking)
    for (const dir of extraDirs) args.push('--add-dir', dir)
    const jail = sandbox && jailed(sandbox, accountDir)
    const env: Record<string, string> = { ...accountEnv(accountDir, apiKey).env, ...jail?.env }
    const servers: Record<string, object> = {}
    if (hotrodMcp) {
      // Claude Code expands ${VAR} in headers, so the token stays out of `ps`.
      const headers = { Authorization: 'Bearer ${HOTROD_MCP_TOKEN}' }
      servers.hotrod = { type: 'http', url: hotrodMcp.url, headers }
      env.HOTROD_MCP_TOKEN = hotrodMcp.token
    }
    for (const server of mcpServers) {
      servers[server.name] = { type: 'stdio', command: server.command, args: server.args ?? [], env: server.env ?? {} }
    }
    if (Object.keys(servers).length) args.push('--mcp-config', JSON.stringify({ mcpServers: servers }))
    const allowed = [
      ...(hotrodMcp ? ['mcp__hotrod__*'] : []),
      ...mcpServers.flatMap((server) => (server.allowTools ? [`mcp__${server.name}__*`] : [])),
      // Read rules are gitignore patterns, `//` from the root; `*`, `?` and `\` can't be escaped in them.
      ...readFiles.map((path) => `Read(/${path.replace(/[[\]]/g, '\\$&')})`),
    ]
    if (allowed.length) args.push('--allowedTools', ...allowed)
    if (instructions) args.push('--append-system-prompt', instructions)
    const proc = machine.spawn('claude', args, {
      cwd,
      ...(Object.keys(env).length && { env }),
      ...(jail && { sandbox: jail.sandbox }),
    })
    const send = (message: unknown) => proc.write(JSON.stringify(message) + '\n')
    const pendingInputs = new Map<string, any>()
    const reply = (requestId: string, decide: (input: any) => object) => {
      if (!pendingInputs.has(requestId)) return
      const response = decide(pendingInputs.get(requestId))
      pendingInputs.delete(requestId)
      send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    }
    let buffer = ''
    let interrupted = false
    let closed = false
    let interruptCount = 0
    let limited = false
    const limit = (message: string, resetsAt?: string) => {
      if (limited) return
      limited = true
      emit({ type: 'limit.reached', message, ...(resetsAt && { resetsAt }) })
    }

    const handle = (msg: any) => {
      const subagent = msg.parent_tool_use_id != null
      switch (msg.type) {
        case 'rate_limit_event': {
          const info = msg.rate_limit_info ?? {}
          // Rejected but on overage (extra usage) means the turn goes on and is billed.
          if (info.status !== 'rejected' || info.isUsingOverage === true) return
          const name = LIMIT_NAMES[info.rateLimitType] ?? ''
          return limit(`The account's ${name ? `${name} ` : ''}usage limit is reached`, isoOf(info.resetsAt))
        }
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
          const toolId = request.tool_use_id ? { toolId: request.tool_use_id } : {}
          if (request.tool_name === 'AskUserQuestion') {
            const questions = questionsOf(request.input)
            emit({ type: 'question.asked', requestId: msg.request_id, ...toolId, questions })
            return
          }
          const kind = kindOf(request.tool_name)
          const path = kind === 'edit' ? (request.input?.file_path ?? request.input?.notebook_path) : undefined
          const command = kind === 'shell' ? request.input?.command : undefined
          emit({
            type: 'permission.requested',
            requestId: msg.request_id,
            ...toolId,
            name: request.tool_name,
            kind,
            summary: summarize(kind, request.input),
            ...(typeof path === 'string' && { path }),
            ...(typeof command === 'string' && { command }),
            input: request.input,
          })
          return
        }
        case 'result': {
          const failure = msg.is_error ? String(msg.result || msg.errors?.join('\n') || '') : ''
          if (!interrupted && LIMIT_ERROR.test(failure)) {
            const [text = failure, epoch] = failure.split('|')
            limit(text.trim(), isoOf(epoch))
          }
          const error = interrupted
            ? 'Interrupted'
            : msg.is_error
              ? msg.result || msg.errors?.join('\n') || msg.subtype || 'Claude Code failed'
              : undefined
          interrupted = false
          emit({ type: 'turn.completed', ...(error && { error }) })
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
      if (code === 0 || closed) return emit({ type: 'session.ended' })
      emit({ type: 'session.ended', error: stderrTail.trim() || `Claude Code exited with code ${code}` })
    })

    return {
      prompt(text, images = []) {
        const blocks = images
          .filter(({ base64 }) => base64.length <= MAX_IMAGE_BASE64_CHARS)
          .map(({ mimeType, base64 }) => ({ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }))
        const content = blocks.length ? [{ type: 'text', text }, ...blocks] : text
        limited = false
        send({ type: 'user', message: { role: 'user', content } })
        emit({ type: 'turn.started' })
      },
      interrupt() {
        interrupted = true
        send({ type: 'control_request', request_id: `interrupt-${++interruptCount}`, request: { subtype: 'interrupt' } })
      },
      respond(requestId, allow, message = 'The user denied this tool call.') {
        reply(requestId, (input) => (allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message }))
      },
      answer(requestId, answers) {
        const joined = answers && Object.fromEntries(Object.entries(answers).map(([q, picked]) => [q, picked.join(', ')]))
        reply(requestId, (input) =>
          joined
            ? { behavior: 'allow', updatedInput: { questions: input?.questions, answers: joined } }
            : { behavior: 'deny', message: DECLINED },
        )
      },
      close() {
        closed = true
        proc.closeStdin()
        proc.kill()
      },
    }
  },
}
