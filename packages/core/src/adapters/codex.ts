import { join } from 'node:path'
import {
  type AccountStatus,
  type Adapter,
  type EngineEvent,
  type ImageInput,
  type Machine,
  type Question,
  type Sandbox,
  type SessionOptions,
  type ThinkingLevel,
} from '../shared.ts'
import { onJsonLines } from './jsonl.ts'
import { rpcClient } from './rpc.ts'
import { processUserEnv, type UserEnv } from './user-env.ts'

// Codex, driven through `codex app-server`: JSON-RPC 2.0 (without the "jsonrpc" field) over stdio, one message a line.
// Written against codex-cli 0.167's own schema (`codex app-server generate-ts`).

// The reasoning efforts Codex takes that Kothar names the same; Codex's `ultra` (reasoning plus its own task
// delegation) and `none`/`minimal` on older models have no Kothar level, and `none` reads as off.
const THINKING: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
const levelFrom = (native: unknown): ThinkingLevel | undefined =>
  native === 'none' ? 'off' : native === 'off' ? undefined : THINKING.find((level) => level === native)
const effortOf = (level: ThinkingLevel) => (level === 'off' ? 'none' : level)

// A turn's error that means the account is out of usage, for Codex versions that don't say so in codexErrorInfo.
const LIMIT_ERROR = /usage limit|hit your (?:[\w-]+ )?limit|rate[_ ]limit|out of (?:extra )?(?:usage|credits)|quota/i
const LIMIT_INFO = new Set(['usageLimitExceeded', 'rateLimitExceeded'])

const STEERED = 'Cut short by your message. Codex didn’t report its result.'
const STILL_OPEN = 'Codex didn’t report a result before the turn ended.'

const OUTPUT_TAIL_CHARS = 2000
// Codex's default MCP tool timeout would end a tool call that waits on the user.
const MCP_CALL_TIMEOUT_S = 24 * 60 * 60
const DETECT_TIMEOUT_MS = 20_000
const LOGIN_URL = /https:\/\/auth\.openai\.com\/\S+/
// oxlint-disable-next-line no-control-regex -- strips terminal escape codes on purpose
const ANSI = /\x1b\][^\x07]*\x07|\x1b\[[0-9;]*[A-Za-z]/g

// Codex reads its config, login and state from CODEX_HOME. Each run gets a fresh one, made by the launched process so
// it's on the machine that runs Codex: Kothar's config.toml, and the account's auth.json linked in (an API key account
// gets its own auth.json instead). Codex writes a refreshed login through the link, so the account keeps it.
const LAUNCH = `dir=$(mktemp -d "\${TMPDIR:-/tmp}/kothar-codex.XXXXXX") || exit
trap 'rm -rf "$dir"' EXIT
trap 'exit 143' HUP INT TERM
if [ -n "$KOTHAR_CODEX_AUTH" ]; then (umask 077 && printf %s "$KOTHAR_CODEX_AUTH" > "$dir/auth.json"); else ln -s "$KOTHAR_CODEX_LOGIN/auth.json" "$dir/auth.json"; fi
printf %s "$KOTHAR_CODEX_CONFIG" > "$dir/config.toml"
if [ -n "$KOTHAR_CODEX_SCHEMA" ]; then printf %s "$KOTHAR_CODEX_SCHEMA" > "$dir/schema.json" && set -- "$@" --output-schema "$dir/schema.json"; fi
unset KOTHAR_CODEX_AUTH KOTHAR_CODEX_CONFIG KOTHAR_CODEX_SCHEMA KOTHAR_CODEX_LOGIN
CODEX_HOME=$dir codex "$@"`

// Where a login lives: the account's own folder, else Codex's default home.
const loginDir = (user: UserEnv, accountDir?: string) => accountDir ?? user.env.CODEX_HOME ?? join(user.home, '.codex')

// Codex writes a refreshed login back to auth.json (through the link) and takes a lock beside it.
function jailed(user: UserEnv, sandbox: Sandbox, accountDir?: string): Sandbox {
  return { ...sandbox, writable: [...sandbox.writable, join(loginDir(user, accountDir), 'auth.json*')] }
}

const authOf = (apiKey?: string) => (apiKey ? JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey }) : undefined)

const launchEnv = (user: UserEnv, config: string, accountDir?: string, apiKey?: string, extra: Record<string, string> = {}) => {
  const auth = authOf(apiKey)
  return { KOTHAR_CODEX_LOGIN: loginDir(user, accountDir), KOTHAR_CODEX_CONFIG: config, ...(auth && { KOTHAR_CODEX_AUTH: auth }), ...extra }
}

// TOML basic strings take JSON's escapes.
const str = (value: string) => JSON.stringify(value)
const list = (values: string[]) => `[${values.map(str).join(', ')}]`
const inline = (values: Record<string, string>) =>
  `{ ${Object.entries(values).map(([key, value]) => `${str(key)} = ${str(value)}`).join(', ')} }`

// Everything Codex would otherwise pick up beyond the session's own folder is off: AGENTS.md files (Kothar passes the
// chat's instructions itself), memories, plugins, apps, hooks, its own subagents (Kothar's workers replace them; their
// runs are out of the user's sight), its browser and computer use, bundled skills. Skills from the user's own folders
// load whatever the config says, so each session switches them off over the protocol before its thread starts.
const CLEAN_CONFIG = `project_doc_max_bytes = 0
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
model_reasoning_summary = "auto"

[features]
memories = false
plugins = false
apps = false
hooks = false
multi_agent = false
browser_use = false
computer_use = false
remote_plugin = false
tool_suggest = false
skill_search = false
skill_mcp_dependency_install = false

# Models on Codex's multi-agent v2 get its sub-agent tools whatever multi_agent says. Its prompt text ("a team of
# agents", and the note on when to delegate) comes from these two, and empty leaves it out (codex-cli 0.167).
[features.multi_agent_v2]
disable_native_tools = true
root_agent_usage_hint_text = ""
multi_agent_mode_hint_text = ""

[skills]
include_instructions = false

[skills.bundled]
enabled = false

[history]
persistence = "none"

[analytics]
enabled = false
`

type ConfigOptions = Pick<SessionOptions, 'kotharMcp' | 'mcpServers'> & {
  writableRoots?: string[]
  developerInstructions?: string
}

export function configOf({ kotharMcp, mcpServers = [], writableRoots, developerInstructions }: ConfigOptions) {
  const parts = [CLEAN_CONFIG]
  if (developerInstructions !== undefined) parts.unshift(`developer_instructions = ${str(developerInstructions)}\n`)
  if (writableRoots) {
    parts.push(`[sandbox_workspace_write]\nwritable_roots = ${list(writableRoots)}\nnetwork_access = true\n`)
  }
  const server = (name: string, lines: string[], approve: boolean) =>
    [
      `[mcp_servers.${str(name)}]`,
      ...lines,
      `tool_timeout_sec = ${MCP_CALL_TIMEOUT_S}`,
      `default_tools_approval_mode = ${str(approve ? 'approve' : 'prompt')}`,
      '',
    ].join('\n')
  // Codex reads the bearer token from the variable, so the token stays out of the config file and `ps`.
  if (kotharMcp) parts.push(server('kothar', [`url = ${str(kotharMcp.url)}`, 'bearer_token_env_var = "KOTHAR_MCP_TOKEN"'], true))
  for (const { name, command, args = [], env = {}, allowTools } of mcpServers) {
    const lines = [`command = ${str(command)}`, `args = ${list(args)}`, `env = ${inline(env)}`]
    parts.push(server(name, lines, allowTools === true))
  }
  return parts.join('\n')
}

// The shell tool goes in [features], which CLEAN_CONFIG already opened; TOML takes no table twice.
const withoutTools = (config: string) => config.replace('[features]\n', '[features]\nshell_tool = false\n')

const isoOf = (epoch: unknown) => {
  const seconds = Number(epoch)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return new Date(seconds < 1e12 ? seconds * 1000 : seconds).toISOString()
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

// Codex runs each command as `<shell> -lc '<command>'`; Kothar's checks (read-only, network, secrets) read the command.
const SHELL_WRAPPED = /^(?:\S*\/)?(?:ba|z|da)?sh -(?:lc|cl|c) '((?:[^']|'\\'')*)'$/s
export const commandOf = (wrapped: string) => {
  const inner = wrapped.match(SHELL_WRAPPED)?.[1]
  return inner === undefined ? wrapped : inner.replace(/'\\''/g, "'")
}

const CLIENT_INFO = { name: 'kothar', title: 'Kothar', version: '1' }

// What `model/list` says about one model, as Kothar offers it.
function offersOf(models: any[]) {
  const listed = models.filter((m) => typeof m?.id === 'string' && m.hidden !== true)
  const levelsOf = (model: any): ThinkingLevel[] =>
    THINKING.filter((level) =>
      (model.supportedReasoningEfforts ?? []).some((e: any) => levelFrom(e?.reasoningEffort) === level),
    )
  const engineLevels = THINKING.filter((level) => listed.some((m) => levelsOf(m).includes(level)))
  const modelThinking = Object.fromEntries(
    listed.flatMap((m) => {
      const levels = levelsOf(m)
      return levels.join() === engineLevels.join() ? [] : [[m.id, levels]]
    }),
  )
  const started = listed.find((m) => m.isDefault === true)
  const defaultThinking = levelFrom(started?.defaultReasoningEffort)
  return {
    models: listed.map((m) => m.id as string),
    thinking: engineLevels,
    ...(Object.keys(modelThinking).length && { modelThinking }),
    ...(started && { defaultModel: started.id as string }),
    ...(defaultThinking && { defaultThinking }),
  }
}

// Asks a short-lived app-server for its models. It answers only while its stdin is open, so this can't be a run.
function listModels(user: UserEnv, machine: Machine): Promise<any[] | undefined> {
  return new Promise((resolve) => {
    const env = launchEnv(user, CLEAN_CONFIG)
    const proc = machine.spawn('/bin/sh', ['-c', LAUNCH, 'codex', 'app-server'], { cwd: '/', env })
    const models: any[] = []
    let done = false
    const finish = (result: any[] | undefined) => {
      if (done) return
      done = true
      clearTimeout(timer)
      proc.closeStdin()
      proc.kill()
      resolve(result)
    }
    const timer = setTimeout(() => finish(models.length ? models : undefined), DETECT_TIMEOUT_MS)
    const send = (message: unknown) => proc.write(JSON.stringify(message) + '\n')
    // Answers are read as they come, not through rpcClient: each page is asked for in the same tick its answer lands.
    const lines = onJsonLines(proc, (msg) => {
      if (msg.id === 1) {
        send({ method: 'initialized' })
        return send({ id: 2, method: 'model/list', params: {} })
      }
      if (typeof msg.id !== 'number' || msg.id < 2 || msg.method !== undefined) return
      if (msg.error) return finish(models.length ? models : undefined)
      models.push(...(msg.result?.data ?? []))
      const cursor = msg.result?.nextCursor
      if (cursor) send({ id: msg.id + 1, method: 'model/list', params: { cursor } })
      else finish(models)
    })
    proc.onExit(() => {
      lines.flush()
      finish(models.length ? models : undefined)
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: CLIENT_INFO, capabilities: null } })
  })
}

export const KEYCHAIN_NOTE = 'Signed in through the Keychain, which Kothar’s sessions can’t use: add the account in Kothar'
export const envKeyNote = (name: string) => `${name} is set, but Codex’s sessions don’t read it: add the key as an account in Kothar`

// An API key the user set only in their environment. Codex's login status and app-server both ignore it (checked on
// codex-cli 0.167.0), and Kothar strips OPENAI_API_KEY from what it starts, so it never signs a session in. Read from
// the user's own environment, as loginDir reads CODEX_HOME.
const envKeyOf = (user: UserEnv) => ['CODEX_API_KEY', 'OPENAI_API_KEY'].find((name) => user.env[name]?.trim())

async function authStatus(user: UserEnv, machine: Machine, accountDir?: string): Promise<AccountStatus> {
  const options = { cwd: '/', env: { CODEX_HOME: loginDir(user, accountDir) } }
  const status = await machine.run('codex', ['login', 'status'], options).catch(() => null)
  const text = `${status?.stdout ?? ''}\n${status?.stderr ?? ''}`
  if (status?.code !== 0 || /not logged in/i.test(text)) {
    const envKey = !accountDir && envKeyOf(user)
    return { signedIn: false, ...(envKey && { note: envKeyNote(envKey) }) }
  }
  // Sessions link in auth.json. The user's own Codex may keep its login in the Keychain instead
  // (cli_auth_credentials_store = "keyring" or "auto"), where Kothar's sessions can't reach it.
  if (!accountDir) {
    const file = join(loginDir(user), 'auth.json')
    const found = await machine.run('/bin/sh', ['-c', 'test -e "$1"', 'sh', file], { cwd: '/' }).catch(() => null)
    if (found && found.code !== 0) return { signedIn: false, note: KEYCHAIN_NOTE }
  }
  const email = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0]
  return { signedIn: true, ...(email && { label: email }) }
}

// The tool a thread item is, if it's one Kothar shows as a tool call.
function toolOf(item: any): Extract<EngineEvent, { type: 'tool.started' }> | undefined {
  const toolId = String(item.id)
  switch (item.type) {
    case 'commandExecution':
      return {
        type: 'tool.started',
        toolId,
        name: 'shell',
        kind: 'shell',
        summary: oneLine(commandOf(String(item.command ?? ''))),
        input: { command: item.command, cwd: item.cwd },
      }
    case 'fileChange': {
      const paths = (item.changes ?? []).map((c: any) => c.path).filter((p: unknown) => typeof p === 'string')
      return {
        type: 'tool.started',
        toolId,
        name: 'apply_patch',
        kind: 'edit',
        summary: paths.join(', '),
        input: { changes: item.changes },
        ...(paths[0] !== undefined && { path: paths[0] }),
      }
    }
    case 'mcpToolCall':
      return { type: 'tool.started', toolId, name: `mcp__${item.server}__${item.tool}`, kind: 'mcp', summary: oneLine(JSON.stringify(item.arguments ?? {})), input: item.arguments }
    case 'dynamicToolCall':
      return { type: 'tool.started', toolId, name: String(item.tool), kind: 'other', summary: oneLine(JSON.stringify(item.arguments ?? {})), input: item.arguments }
    case 'webSearch': {
      const action = item.action ?? {}
      const summary = item.query || action.query || action.url || ''
      return { type: 'tool.started', toolId, name: 'web_search', kind: 'fetch', summary: oneLine(summary), input: { query: item.query, action } }
    }
    case 'imageView':
      return { type: 'tool.started', toolId, name: 'view_image', kind: 'read', summary: String(item.path), input: { path: item.path }, path: String(item.path) }
  }
  return undefined
}

const textOf = (content: unknown) =>
  (Array.isArray(content) ? content : []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')

function resultOf(item: any): { output: string; isError: boolean } {
  switch (item.type) {
    case 'commandExecution':
      return { output: item.aggregatedOutput ?? '', isError: item.status !== 'completed' || (item.exitCode ?? 0) !== 0 }
    case 'fileChange': {
      const output = (item.changes ?? []).map((c: any) => c.diff ?? '').join('\n')
      return { output: item.status === 'declined' ? 'The patch was declined.' : output, isError: item.status !== 'completed' }
    }
    case 'mcpToolCall':
      return item.error
        ? { output: String(item.error.message ?? ''), isError: true }
        : { output: textOf(item.result?.content), isError: item.status === 'failed' }
    case 'dynamicToolCall':
      return { output: textOf(item.contentItems?.map((c: any) => ({ type: 'text', text: c.text ?? '' }))), isError: item.success === false }
    default:
      return { output: '', isError: false }
  }
}

// The file a patch approval is about: the first one outside the session's folder, if any, so a policy that allows edits
// in the folder can't wave through a patch that also writes elsewhere.
function patchPath(paths: string[], cwd: string) {
  const inside = (path: string) => !path.startsWith('/') || path === cwd || path.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)
  return paths.find((p) => !inside(p) || p.includes('..')) ?? paths[0]
}

const questionsOf = (questions: any[]): Question[] =>
  questions.map((q) => ({
    header: String(q.header ?? ''),
    question: String(q.question ?? ''),
    options: (q.options ?? []).map((o: any) => ({ label: String(o.label ?? ''), description: String(o.description ?? '') })),
    multiSelect: false,
  }))

const inputOf = (text: string, images: ImageInput[] = []) => [
  { type: 'text', text, text_elements: [] },
  ...images.map(({ mimeType, base64 }) => ({ type: 'image', url: `data:${mimeType};base64,${base64}` })),
]

export function createCodex(user: UserEnv = processUserEnv()): Adapter {
  return {
    id: 'codex',
    name: 'Codex',
    imageInput: true,
    kotharMcp: true,
    steering: true,

    async detect(machine) {
      const version = await machine.run('codex', ['--version'], { cwd: '/' }).catch(() => null)
      if (version?.code !== 0) return { installed: false, signedIn: false }
      const [{ signedIn }, models] = await Promise.all([authStatus(user, machine), listModels(user, machine)])
      return { installed: true, signedIn, detail: version.stdout.trim(), ...(models ? offersOf(models) : {}) }
    },

    accounts: {
      status: (machine, accountDir) => authStatus(user, machine, accountDir),

      // Codex's browser sign-in: it prints a link (and opens it), then waits on localhost for the redirect. Its messages
      // go to stderr, so they're joined to stdout to catch the link as it comes. Codex opens the browser through macOS
      // LaunchServices, which no flag or variable turns off (codex-cli 0.167), so Kothar only shows the link as a fallback.
      login(machine, accountDir, emit) {
        const command = 'exec codex login -c cli_auth_credentials_store=\'"file"\' 2>&1'
        const proc = machine.spawn('/bin/sh', ['-c', command], { cwd: accountDir, env: { CODEX_HOME: accountDir } })
        let output = ''
        let sentUrl = false
        proc.onStdout((chunk) => {
          output = (output + chunk).slice(-OUTPUT_TAIL_CHARS)
          const url = !sentUrl && output.replace(ANSI, '').match(LOGIN_URL)?.[0]
          if (!url) return
          sentUrl = true
          emit({ type: 'url', url, noCode: true })
        })
        proc.onExit((code, stderrTail) => {
          if (code === 0) return emit({ type: 'done' })
          const text = oneLine((output + stderrTail).replace(ANSI, ''))
          const error = text.match(/(?:Error|error)[^.]*\.?/)?.[0] ?? `Codex sign-in exited with code ${code}`
          emit({ type: 'failed', error })
        })
        // The redirect finishes the sign-in; there's no code to paste.
        return { submitCode: () => {}, cancel: () => proc.kill() }
      },

      async logout(machine, accountDir) {
        await machine.run('codex', ['logout'], { cwd: '/', env: { CODEX_HOME: accountDir } })
      },

      apiKeys: true,
    },

    async complete(machine, { cwd, system, prompt, schema, model, timeoutMs, accountDir, apiKey, sandbox }) {
      const config = withoutTools(configOf({ developerInstructions: system }))
      const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd]
      args.push('--model', model, '-c', 'model_reasoning_effort="low"')
      const schemaEnv: Record<string, string> = schema ? { KOTHAR_CODEX_SCHEMA: JSON.stringify(schema) } : {}
      const options = {
        cwd,
        input: prompt,
        timeoutMs,
        env: launchEnv(user, config, accountDir, apiKey, schemaEnv),
        ...(sandbox && { sandbox: jailed(user, sandbox, accountDir) }),
      }
      const { code, stdout, stderr } = await machine.run('/bin/sh', ['-c', LAUNCH, 'codex', ...args], options)
      let reply: string | undefined
      let failure: string | undefined
      for (const line of stdout.split('\n')) {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') reply = String(event.item.text ?? '')
        if (event.type === 'turn.failed') failure = String(event.error?.message ?? 'Codex failed')
      }
      if (failure || code !== 0 || reply === undefined) {
        throw new Error(failure || stderr.trim().split('\n').at(-1) || `Codex exited with code ${code}`)
      }
      return reply
    },

    start(machine, options, emit) {
      const { cwd, instructions, accountDir, apiKey, kotharMcp, mcpServers = [], extraDirs = [], model, thinking, sandbox } =
        options
      // Inside Kothar's sandbox Codex can't start its own (macOS won't nest them), and needs none; without it, Codex's
      // workspace sandbox keeps writes to the session's folders and asks before anything else.
      const codexSandbox = sandbox ? 'danger-full-access' : 'workspace-write'
      const config = configOf({ kotharMcp, mcpServers, ...(!sandbox && { writableRoots: extraDirs }) })
      const env = launchEnv(user, config, accountDir, apiKey, kotharMcp ? { KOTHAR_MCP_TOKEN: kotharMcp.token } : {})
      const proc = machine.spawn('/bin/sh', ['-c', LAUNCH, 'codex', 'app-server'], {
        cwd,
        env,
        ...(sandbox && { sandbox: jailed(user, sandbox, accountDir) }),
      })
      // JSON-RPC without the "jsonrpc" field; a request after Codex exits fails at once.
      const client = rpcClient(proc, {
        jsonrpc: false,
        errorText: (error) => String(error.message ?? 'Codex refused the request'),
        onRequest: (id, method, params) => serverRequest(id, method, params),
        onNotification: (method, params) => notify(method, params),
      })
      const request = (method: string, params: unknown) =>
        exited ? Promise.reject(new Error('Codex has stopped')) : client.request(method, params)
      // Server requests Kothar answers later: the request's JSON-RPC id and how to answer it, by Kothar's request id.
      const asked = new Map<string, { id: unknown; method: string; params: any }>()
      const reply = client.respond

      let exited = false
      let closed = false
      let threadId: string | undefined
      let turnOpen = false
      let turnId: string | undefined
      let interruptWanted = false
      let limited = false
      let lastError: { message: string; info?: unknown } | undefined
      let rateLimits: any
      // Turns Codex started on its own (input left over from a turn that ended); Kothar stops them and ignores them.
      const foreign = new Set<string>()
      const items = new Map<string, any>()
      // Steered messages, by Kothar's id: sent to the turn (accepted once Codex answers) and not yet seen in it.
      const steers = new Map<string, { accepted: boolean }>()
      const unsent: { id: string; text: string; images?: ImageInput[] }[] = []

      // Tool calls closed as stopped; should Codex report one after all, it's not shown twice.
      const stopped = new Set<string>()
      // Closes the open tool calls Codex will never report done, as stopped.
      const cutShort = (output: string, which: (item: any, id: string) => boolean = () => true) => {
        for (const [id, item] of items) {
          if (!toolOf(item) || !which(item, id)) continue
          items.delete(id)
          stopped.add(id)
          emit({ type: 'tool.completed', toolId: id, output, isError: false, stopped: true })
        }
      }
      // A command still waiting on the user's approval isn't running yet, so a steer doesn't cut it short.
      const awaitingApproval = (id: string) => [...asked.values()].some((a) => String(a.params?.itemId) === id)

      const limit = (message: string) => {
        if (limited) return
        limited = true
        // The window that's used up says when the limit lifts.
        const windows = [rateLimits?.primary, rateLimits?.secondary].filter(Boolean)
        const full = windows.filter((w: any) => Number(w.usedPercent) >= 100)
        const resetsAt = isoOf((full.length ? full : windows).map((w: any) => w.resetsAt).filter(Boolean).sort().at(-1))
        emit({ type: 'limit.reached', message, ...(resetsAt && { resetsAt }) })
      }

      const endTurn = (error?: string, info?: unknown) => {
        if (!turnOpen) return
        turnOpen = false
        turnId = undefined
        interruptWanted = false
        lastError = undefined
        // Anything Codex never finished (an interrupted turn, a call still open at its end) shows as stopped.
        cutShort(STILL_OPEN)
        items.clear()
        stopped.clear()
        // A steer Codex took (it answered with the turn's id) is part of the turn even if its message never showed.
        for (const [id, steer] of steers) emit({ type: steer.accepted ? 'steer.landed' : 'steer.returned', id })
        steers.clear()
        for (const { id } of unsent.splice(0)) emit({ type: 'steer.returned', id })
        const limitHit = typeof info === 'string' && LIMIT_INFO.has(info)
        if (error && error !== 'Interrupted' && (limitHit || LIMIT_ERROR.test(error))) limit(error)
        emit({ type: 'turn.completed', ...(error && { error }) })
      }

      const interruptTurn = (id: string) => {
        if (threadId) request('turn/interrupt', { threadId, turnId: id }).catch(() => {})
      }

      const sendSteer = (id: string, text: string, images?: ImageInput[]) => {
        steers.set(id, { accepted: false })
        request('turn/steer', { threadId, expectedTurnId: turnId, clientUserMessageId: id, input: inputOf(text, images) })
          .then(() => {
            const steer = steers.get(id)
            if (steer) steer.accepted = true
          })
          .catch(() => {
            if (!steers.delete(id)) return
            emit({ type: 'steer.returned', id })
          })
      }

      const ourTurn = (id: string) => {
        if (!turnOpen || foreign.has(id)) return false
        if (turnId === undefined) {
          turnId = id
          if (interruptWanted) interruptTurn(id)
          for (const steer of unsent.splice(0)) sendSteer(steer.id, steer.text, steer.images)
        }
        return id === turnId
      }

      const notify = (method: string, params: any) => {
        const inTurn = params?.turnId === undefined || ourTurn(String(params.turnId))
        switch (method) {
          case 'turn/started': {
            const id = String(params.turn?.id)
            if (turnOpen && (turnId === undefined || turnId === id)) return void ourTurn(id)
            foreign.add(id)
            return interruptTurn(id)
          }
          case 'turn/completed': {
            const turn = params.turn ?? {}
            const id = String(turn.id)
            if (foreign.delete(id) || !ourTurn(id)) return
            if (turn.status === 'interrupted') return endTurn('Interrupted')
            if (turn.status === 'failed') {
              const error = turn.error ?? lastError
              return endTurn(String(error?.message || 'Codex failed'), error?.codexErrorInfo ?? lastError?.info)
            }
            return endTurn()
          }
          case 'error':
            if (!inTurn || params.willRetry === true) return
            lastError = { message: String(params.error?.message ?? ''), info: params.error?.codexErrorInfo }
            return
          case 'account/rateLimits/updated':
            rateLimits = params.rateLimits
            return
          // A request Codex no longer waits on, answered or not: its command, if any, may now run.
          case 'serverRequest/resolved':
            for (const [key, pending] of asked) if (pending.id === params?.requestId) asked.delete(key)
            return
        }
        if (!inTurn) return
        switch (method) {
          case 'item/agentMessage/delta':
            if (params.delta) emit({ type: 'text.delta', text: params.delta })
            return
          case 'item/reasoning/summaryTextDelta':
          case 'item/reasoning/textDelta':
            if (params.delta) emit({ type: 'thinking.delta', text: params.delta })
            return
          case 'item/reasoning/summaryPartAdded':
            if (params.summaryIndex > 0) emit({ type: 'thinking.delta', text: '\n\n' })
            return
          case 'item/started': {
            const item = params.item ?? {}
            items.set(String(item.id), item)
            if (item.type === 'userMessage' && typeof item.clientId === 'string' && steers.delete(item.clientId)) {
              // A steer cuts short the wait on any command still running, and Codex never reports that command done.
              cutShort(STEERED, (open, id) => open.type === 'commandExecution' && !awaitingApproval(id))
              return emit({ type: 'steer.landed', id: item.clientId })
            }
            const tool = toolOf(item)
            if (tool) emit(tool)
            return
          }
          case 'item/completed': {
            const item = params.item ?? {}
            const started = items.get(String(item.id))
            items.delete(String(item.id))
            if (stopped.delete(String(item.id))) return
            if (item.type === 'agentMessage' && item.text) return emit({ type: 'text.completed', text: item.text })
            if (item.type === 'userMessage' && typeof item.clientId === 'string' && steers.delete(item.clientId)) {
              return emit({ type: 'steer.landed', id: item.clientId })
            }
            if (!toolOf(item)) return
            // An item Codex reports only once done (some do) still shows as a call.
            if (!started) emit(toolOf(item)!)
            return emit({ type: 'tool.completed', toolId: String(item.id), ...resultOf(item) })
          }
        }
      }

      const serverRequest = (id: unknown, method: string, params: any) => {
        const requestId = `codex-${String(id)}`
        const toolId = params?.itemId !== undefined ? { toolId: String(params.itemId) } : {}
        const ask = (event: Omit<Extract<EngineEvent, { type: 'permission.requested' }>, 'type' | 'requestId'>) => {
          asked.set(requestId, { id, method, params })
          emit({ type: 'permission.requested', requestId, ...toolId, ...event })
        }
        switch (method) {
          case 'item/commandExecution/requestApproval': {
            const command = commandOf(String(params.command ?? ''))
            // A command that wants the network is still a command: allowing it runs it.
            const summary = oneLine(command || params.reason || '')
            return ask({ name: 'shell', kind: 'shell', summary, ...(command && { command }), input: params })
          }
          case 'item/fileChange/requestApproval': {
            const changes = items.get(String(params.itemId))?.changes ?? []
            const paths = changes.map((c: any) => c.path).filter((p: unknown) => typeof p === 'string')
            const path = patchPath(paths, cwd) ?? params.grantRoot
            const summary = paths.join(', ') || params.reason || 'Apply a patch'
            return ask({ name: 'apply_patch', kind: 'edit', summary, ...(typeof path === 'string' && { path }), input: params })
          }
          case 'item/permissions/requestApproval':
            return ask({ name: 'request_permissions', kind: 'other', summary: oneLine(params.reason ?? JSON.stringify(params.permissions ?? {})), input: params })
          case 'mcpServer/elicitation/request':
            return ask({ name: `mcp__${params.serverName}`, kind: 'mcp', summary: oneLine(params.message ?? ''), input: params })
          case 'item/tool/requestUserInput':
            asked.set(requestId, { id, method, params })
            return emit({ type: 'question.asked', requestId, ...toolId, questions: questionsOf(params.questions ?? []) })
        }
        // Anything else (a login refresh Codex wants from its client, the v1 approvals) Kothar doesn't do.
        client.fail(id, { code: -32601, message: `Kothar doesn't handle ${method}` })
      }

      proc.onExit((code, stderrTail) => {
        client.flush()
        exited = true
        client.abandon('Codex has stopped')
        if (code === 0 || closed) return emit({ type: 'session.ended' })
        const tail = stderrTail.replace(ANSI, '').split('\n').filter((l) => l.trim() && !/^WARNING:/.test(l)).slice(-3).join('\n')
        emit({ type: 'session.ended', error: tail.trim() || `Codex exited with code ${code}` })
      })

      const dirs = extraDirs.map((dir) => `\n- ${dir}`).join('')
      const developerInstructions = [instructions, dirs && `You can also work in these folders:${dirs}`].filter(Boolean).join('\n\n')
      const ready = (async () => {
        await request('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
        client.notify('initialized')
        // Skills in the user's own folders and the project's load whatever the config says; switch each one off.
        const listed = await request('skills/list', { cwds: [cwd] }).catch(() => undefined)
        const skills = (listed?.data ?? []).flatMap((entry: any) => entry.skills ?? [])
        await Promise.all(
          skills
            .filter((skill: any) => skill.enabled !== false && typeof skill.path === 'string')
            .map((skill: any) => request('skills/config/write', { path: skill.path, enabled: false }).catch(() => {})),
        )
        const started = await request('thread/start', {
          cwd,
          ...(model && { model }),
          approvalPolicy: 'untrusted',
          sandbox: codexSandbox,
          ...(developerInstructions && { developerInstructions }),
          ephemeral: true,
        })
        threadId = String(started.thread.id)
      })()
      ready.catch(() => {})

      return {
        prompt(text, images = []) {
          limited = false
          turnOpen = true
          turnId = undefined
          emit({ type: 'turn.started' })
          ready
            .then(() =>
              request('turn/start', {
                threadId,
                input: inputOf(text, images),
                ...(model && { model }),
                ...(thinking && { effort: effortOf(thinking) }),
              }),
            )
            .then((result) => void ourTurn(String(result?.turn?.id)))
            .catch((error) => {
              if (!exited) endTurn(error instanceof Error ? error.message : String(error))
            })
        },
        // Codex takes a steered message into the running turn at its next step (turn/steer).
        steer(id, text, images) {
          if (!turnOpen) return emit({ type: 'steer.returned', id })
          if (turnId === undefined) unsent.push({ id, text, ...(images && { images }) })
          else sendSteer(id, text, images)
        },
        interrupt() {
          if (!turnOpen) return
          interruptWanted = true
          if (turnId !== undefined) interruptTurn(turnId)
        },
        respond(requestId, allow) {
          const pending = asked.get(requestId)
          if (!pending || pending.method === 'item/tool/requestUserInput') return
          asked.delete(requestId)
          if (pending.method === 'item/permissions/requestApproval') {
            return reply(pending.id, { permissions: allow ? (pending.params.permissions ?? {}) : {}, scope: 'turn' })
          }
          if (pending.method === 'mcpServer/elicitation/request') {
            return reply(pending.id, { action: allow ? 'accept' : 'decline', content: allow ? {} : null, _meta: null })
          }
          reply(pending.id, { decision: allow ? 'accept' : 'decline' })
        },
        answer(requestId, answers) {
          const pending = asked.get(requestId)
          if (!pending || pending.method !== 'item/tool/requestUserInput') return
          asked.delete(requestId)
          // Kothar keys answers by question text; Codex by question id. No answers: each question unanswered.
          const byId = Object.fromEntries(
            (pending.params.questions ?? []).map((q: any) => [q.id, { answers: answers?.[q.question] ?? [] }]),
          )
          reply(pending.id, { answers: byId })
        },
        close() {
          closed = true
          proc.closeStdin()
          proc.kill()
        },
      }
    },
  }
}

export const codex = createCodex()
