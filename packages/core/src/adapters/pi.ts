import { join } from 'node:path'
import { type Adapter, type Sandbox, type ThinkingLevel, type ToolKind } from '../shared.ts'
import { onJsonLines } from './jsonl.ts'
import { processUserEnv, type UserEnv } from './user-env.ts'

const KINDS: Record<string, ToolKind> = {
  bash: 'shell',
  powershell: 'shell',
  edit: 'edit',
  write: 'edit',
  read: 'read',
  ls: 'read',
  grep: 'search',
  find: 'search',
}

const SUMMARY_FIELDS: Partial<Record<ToolKind, string[]>> = {
  shell: ['command'],
  edit: ['path'],
  read: ['path'],
  search: ['pattern'],
}

// The thinking levels pi takes, passed as --thinking as they are. pi also has `minimal`, which Kothar doesn't offer;
// read back from pi, it counts as low.
const THINKING: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
const levelFrom = (native: unknown) => (native === 'minimal' ? 'low' : THINKING.find((level) => level === native))

// The levels one of pi's models takes, as pi works it out (getSupportedThinkingLevels in pi-ai 1.5): none for a model
// without reasoning; xhigh and max only where its thinkingLevelMap names them; any level it maps to null, never.
// Undefined when pi doesn't say whether the model reasons, so the engine's list applies.
function levelsOfModel({ reasoning, thinkingLevelMap: map }: { reasoning?: unknown; thinkingLevelMap?: any }) {
  if (reasoning === undefined) return undefined
  if (!reasoning) return []
  return THINKING.filter((level) => {
    const mapped = map?.[level]
    return mapped !== null && (level === 'xhigh' || level === 'max' ? mapped !== undefined : true)
  })
}

const CLEAN_ARGS = [
  '--no-session',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-context-files',
  '--no-approve',
]

const RPC_ARGS = ['--mode', 'rpc', ...CLEAN_ARGS]

// The provider's error once pi has stopped retrying: a usage cap, a rate limit or an exhausted quota.
const LIMIT_ERROR = /usage limit|rate[_ ]limit|\b429\b|too many requests|quota|resource[_ ]exhausted/i

// pi reads MCP servers only from <agent dir>/mcp.json, so each session gets its own agent dir with only pi's login
// and model lists linked in. The launched process makes it, so it is on the machine that runs pi.
const LAUNCH = `dir=$(mktemp -d "\${TMPDIR:-/tmp}/kothar-pi.XXXXXX") || exit
trap 'rm -rf "$dir"' EXIT
trap 'exit 143' HUP INT TERM
for file in auth.json models.json models-store.json; do ln -s "$KOTHAR_PI_LOGIN/$file" "$dir/$file"; done
printf %s "$KOTHAR_PI_MCP" > "$dir/mcp.json"
PI_CODING_AGENT_DIR=$dir pi "$@"`

// pi's default 60 s would end a tool call that waits on the user.
const MCP_CALL_TIMEOUT_S = 24 * 60 * 60

// pi fails with its login read-only, and needs nothing else of its state folder.
const STATE_FILES = ['auth.json*', 'settings.json.lock*', 'models-store.json*', 'install/update.lock*']

const stateDir = (user: UserEnv) => user.env.PI_CODING_AGENT_DIR ?? join(user.home, '.pi', 'agent')

function jailed(user: UserEnv, sandbox: Sandbox) {
  return { ...sandbox, writable: [...sandbox.writable, ...STATE_FILES.map((file) => join(stateDir(user), file))] }
}

const kindOf = (name: string): ToolKind => (name.startsWith('mcp__') ? 'mcp' : (KINDS[name] ?? 'other'))

function summarize(kind: ToolKind, input: any): string {
  const picked = SUMMARY_FIELDS[kind]?.map((key) => input?.[key]).find((value) => typeof value === 'string')
  return (picked ?? JSON.stringify(input) ?? '').replace(/\s+/g, ' ').trim()
}

const textOf = (content: any): string =>
  (Array.isArray(content) ? content : []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')

export function createPi(user: UserEnv = processUserEnv()): Adapter {
  return {
    id: 'pi',
    name: 'pi',
    imageInput: true,
    kotharMcp: true,
    steering: true,

    async detect(machine) {
      const options = { cwd: '/' }
      const version = await machine.run('pi', ['--version'], options).catch(() => null)
      if (version?.code !== 0) return { installed: false, signedIn: false }
      const input = ['get_available_models', 'get_state'].map((type) => JSON.stringify({ type }) + '\n').join('')
      const rpc = await machine.run('pi', [...RPC_ARGS, '--no-mcp', '--offline'], { ...options, input }).catch(() => null)
      const answers: Record<string, any> = {}
      for (const line of rpc?.stdout.split('\n') ?? []) {
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'response' && msg.success) answers[msg.command] = msg.data
        } catch {}
      }
      const listed = ((answers.get_available_models?.models ?? []) as any[]).filter(({ provider, id }) => provider && id)
      const models = listed.map(({ provider, id }) => `${provider}/${id}`)
      const modelThinking = Object.fromEntries(
        listed.flatMap((model) => {
          const levels = levelsOfModel(model)
          return levels && levels.join() !== THINKING.join() ? [[`${model.provider}/${model.id}`, levels]] : []
        }),
      )
      const { model: started, thinkingLevel } = answers.get_state ?? {}
      const startedId = `${started?.provider}/${started?.id}`
      const defaultThinking = levelFrom(thinkingLevel)
      const defaultModel = models.includes(startedId) ? startedId : undefined
      return {
        installed: true,
        signedIn: models.length > 0,
        detail: version.stdout.trim(),
        models,
        thinking: THINKING,
        ...(Object.keys(modelThinking).length && { modelThinking }),
        ...(defaultModel && { defaultModel }),
        ...(defaultThinking && { defaultThinking }),
      }
    },

    async complete(machine, { cwd, system, prompt, model, timeoutMs, sandbox }) {
      const args = ['-p', ...CLEAN_ARGS, '--no-mcp', '--no-tools', '--offline', '--model', model, '--thinking', 'off']
      args.push('--system-prompt', system)
      const options = { cwd, input: prompt, timeoutMs, ...(sandbox && { sandbox: jailed(user, sandbox) }) }
      const { code, stdout, stderr } = await machine.run('pi', args, options)
      if (code !== 0) throw new Error(stderr.trim() || `pi exited with code ${code}`)
      return stdout
    },

    start(machine, { cwd, instructions, kotharMcp, mcpServers = [], extraDirs = [], model, thinking, sandbox }, emit) {
      const args = [...RPC_ARGS, '-e', 'builtin:mcp']
      if (model) args.push('--model', model)
      if (thinking) args.push('--thinking', thinking)
      const dirs = extraDirs.map((dir) => `\n- ${dir}`).join('')
      const systemPrompt = [instructions, dirs && `You can also work in these folders:${dirs}`].filter(Boolean)
      if (systemPrompt.length) args.push('--append-system-prompt', systemPrompt.join('\n\n'))
      const direct = { exposure: 'direct', timeout: MCP_CALL_TIMEOUT_S }
      const servers: Record<string, object> = {}
      if (kotharMcp) {
        servers.kothar = { url: kotharMcp.url, headers: { Authorization: 'Bearer ${KOTHAR_MCP_TOKEN}' }, ...direct }
      }
      for (const server of mcpServers) {
        servers[server.name] = { command: server.command, args: server.args ?? [], env: server.env ?? {}, ...direct }
      }
      const env = {
        KOTHAR_PI_LOGIN: stateDir(user),
        KOTHAR_PI_MCP: JSON.stringify({ mcpServers: servers }),
        ...(kotharMcp && { KOTHAR_MCP_TOKEN: kotharMcp.token }),
      }
      const proc = machine.spawn('/bin/sh', ['-c', LAUNCH, 'pi', ...args], {
        cwd,
        env,
        ...(sandbox && { sandbox: jailed(user, sandbox) }),
      })
      const send = (command: unknown) => proc.write(JSON.stringify(command) + '\n')
      // Each steer command's request id, to match a refusal to its message.
      const steerIds = new Map<string, string>()
      let turnError: string | undefined
      let closed = false
      // Steered messages not yet taken in, oldest first. pi's user messages carry no id, and it delivers steers in order,
      // so each user message after the prompt's is the oldest waiting steer.
      let steers: string[] = []
      let promptSeen = false
      let steeredBefore = false
      const settleSteer = (type: 'steer.landed' | 'steer.returned', id = steers[0]) => {
        if (id === undefined || !steers.includes(id)) return
        steers = steers.filter((s) => s !== id)
        emit({ type, id })
      }

      const endTurn = (error?: string) => {
        turnError = undefined
        for (const id of steers) emit({ type: 'steer.returned', id })
        steers = []
        if (error && error !== 'Interrupted' && LIMIT_ERROR.test(error)) emit({ type: 'limit.reached', message: error })
        emit({ type: 'turn.completed', ...(error && { error }) })
      }

      const handle = (msg: any) => {
        switch (msg.type) {
          case 'message_update': {
            const { type, delta } = msg.assistantMessageEvent ?? {}
            if (!delta) return
            if (type === 'text_delta') emit({ type: 'text.delta', text: delta })
            if (type === 'thinking_delta') emit({ type: 'thinking.delta', text: delta })
            return
          }
          case 'message_end': {
            const message = msg.message ?? {}
            if (message.role === 'user') {
              if (promptSeen) settleSteer('steer.landed')
              promptSeen = true
              return
            }
            if (message.role !== 'assistant') return
            for (const block of message.content ?? []) {
              if (block.type === 'text' && block.text) emit({ type: 'text.completed', text: block.text })
            }
            turnError = message.stopReason === 'error' ? message.errorMessage || 'pi failed' : undefined
            return
          }
          case 'tool_execution_start': {
            const kind = kindOf(msg.toolName)
            const summary = summarize(kind, msg.args)
            const path = kind === 'edit' || kind === 'read' ? msg.args?.path : undefined
            const { toolCallId: toolId, toolName: name, args: input } = msg
            emit({ type: 'tool.started', toolId, name, kind, summary, input, ...(typeof path === 'string' && { path }) })
            return
          }
          case 'tool_execution_end':
            emit({ type: 'tool.completed', toolId: msg.toolCallId, output: textOf(msg.result?.content), isError: msg.isError === true })
            return
          case 'agent_settled':
            // An abort during a tool call ends the next message with stopReason "error", so `aborted` wins.
            endTurn(msg.aborted ? 'Interrupted' : turnError)
            return
          case 'response':
            if (msg.command === 'steer' && !msg.success) return settleSteer('steer.returned', steerIds.get(msg.id))
            if (msg.command !== 'prompt') return
            if (!msg.success) endTurn(msg.error || 'pi rejected the prompt')
            else if (msg.data?.disposition === 'handled') endTurn()
        }
      }

      const lines = onJsonLines(proc, handle)
      proc.onExit((code, stderrTail) => {
        lines.flush()
        if (code === 0 || closed) return emit({ type: 'session.ended' })
        emit({ type: 'session.ended', error: stderrTail.trim() || `pi exited with code ${code}` })
      })

      return {
        prompt(text, images = []) {
          const attached = images.map(({ mimeType, base64 }) => ({ type: 'image', data: base64, mimeType }))
          promptSeen = false
          send({ type: 'prompt', message: text, ...(attached.length && { images: attached }) })
          emit({ type: 'turn.started' })
        },
        steer(id, text, images = []) {
          const attached = images.map(({ mimeType, base64 }) => ({ type: 'image', data: base64, mimeType }))
          // Every waiting steer at the next tool boundary, not one per model call.
          if (!steeredBefore) send({ type: 'set_steering_mode', mode: 'all' })
          steeredBefore = true
          steers.push(id)
          steerIds.set(`steer-${id}`, id)
          send({ type: 'steer', id: `steer-${id}`, message: text, ...(attached.length && { images: attached }) })
        },
        interrupt() {
          // Otherwise pi runs waiting steers after the abort; they go back to Kothar's queue at the turn's end.
          if (steers.length) send({ type: 'clear_queue' })
          send({ type: 'abort' })
        },
        respond() {},
        close() {
          closed = true
          proc.closeStdin()
          proc.kill()
        },
      }
    },
  }
}

export const pi = createPi()
