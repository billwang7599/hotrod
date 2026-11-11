import { join } from 'node:path'
import {
  THINKING_LEVELS,
  type AccountMethod,
  type AccountProvider,
  type AccountStatus,
  type Adapter,
  type Machine,
  type Sandbox,
  type ThinkingLevel,
  type ToolKind,
} from '../shared.ts'
import { acpStdioServer, kindOfAcp, levelsOfEfforts, startAcpSession, type AcpMcpServer, type AcpToolCall } from './acp.ts'
import { processUserEnv, type UserEnv } from './user-env.ts'

// OpenCode (opencode.ai) runs as `opencode acp`: the Agent Client Protocol over stdio (acp.ts). Its sessions take
// Kothar's MCP servers in session/new and ask before edits and commands with session/request_permission. Each session
// runs on config, data and state folders of its own, so none of the user's config, plugins, agents, instructions, MCP
// servers or session history load, with only the account's auth.json linked in.

const KINDS: Record<string, ToolKind> = {
  bash: 'shell',
  edit: 'edit',
  write: 'edit',
  patch: 'edit',
  apply_patch: 'edit',
  multiedit: 'edit',
  read: 'read',
  list: 'read',
  grep: 'search',
  glob: 'search',
  codesearch: 'search',
  webfetch: 'fetch',
  websearch: 'fetch',
}

const SUMMARY_FIELDS: Partial<Record<ToolKind, string[]>> = {
  shell: ['command', 'description'],
  edit: ['filePath', 'filepath', 'path'],
  read: ['filePath', 'filepath', 'path'],
  search: ['pattern', 'query'],
  fetch: ['url', 'query'],
}

// Clean runs: no external plugins. Errors reach Kothar only through OpenCode's log (ACP has no error stop reason).
const CLEAN_ARGS = ['--pure']
const LOG_ARGS = ['--print-logs', '--log-level', 'ERROR']

// Off for every OpenCode run: its update check, sharing, its own project and Claude Code files, downloads it does on
// its own. The config, data and state folders are per run (LAUNCH).
// Its internal plugins stay on: they are the provider sign-ins (ChatGPT, GitHub Copilot, xAI and others), without
// which those logins can neither be added nor used. --pure keeps out every plugin from outside.
const CLEAN_ENV = {
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_SHARE: '1',
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
  OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
}

// OpenCode's tools that run out of Kothar's sight or bypass it: its own subagents (Kothar's spawn_worker replaces
// them), skills and its question tool.
const TOOLS_OFF = { task: false, skill: false, question: false }

// A Kothar tool call can wait on the user; OpenCode's default MCP timeout would end it.
const MCP_CALL_TIMEOUT_MS = 24 * 60 * 60 * 1000

// The provider's error once OpenCode logs it: a usage cap, a rate limit or an exhausted quota.
const LIMIT_ERROR = /usage limit|rate[_ ]?limit|\b429\b|too many requests|quota|resource[_ ]exhausted/i
// The log lines that carry a model call's error: each failed attempt ("stream error") and the turn's last ("process").
const ERROR_LINE = /\blevel=ERROR\b.*\bmessage=(?:"stream error"|process\b)/
const ERROR_FIELD = /\berror(?:\.error)?="((?:[^"\\]|\\.)*)"/

// The agent `complete` runs: the system prompt in place of OpenCode's, no tools.
const COMPLETE_AGENT = 'kothar-complete'

// Each run gets its own config, data and state folders, made on the machine that runs OpenCode, with Kothar's
// config and instructions (the global AGENTS.md of that config folder) and the account's login linked in. Commands
// and MCP servers OpenCode starts get the user's own XDG folders and shell back (RESTORE), so `gh`, git and the rest
// still find their config.
const LAUNCH = `dir=$(mktemp -d "\${TMPDIR:-/tmp}/kothar-opencode.XXXXXX") || exit
trap 'rm -rf "$dir"' EXIT
trap 'exit 143' HUP INT TERM
mkdir -p "$dir/config/opencode" "$dir/data/opencode" "$dir/state" "$dir/bin" || exit
auth=\${KOTHAR_OPENCODE_AUTH:-\${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json}
{ [ -f "$auth" ] || [ -n "$KOTHAR_OPENCODE_SIGNIN" ]; } && ln -s "$auth" "$dir/data/opencode/auth.json"
printf %s "$KOTHAR_OPENCODE_CONFIG" > "$dir/config/opencode/opencode.json"
printf %s "$KOTHAR_OPENCODE_INSTRUCTIONS" > "$dir/config/opencode/AGENTS.md"
printf %s "$KOTHAR_OPENCODE_RESTORE" > "$dir/restore.sh"
shell=\${SHELL:-/bin/sh}
printf '#!/bin/sh\\n. "%s/restore.sh"\\nexec "$SHELL" "$@"\\n' "$dir" > "$dir/bin/\${shell##*/}"
chmod +x "$dir/bin/\${shell##*/}"
[ -n "\${XDG_CONFIG_HOME+x}" ] && export KOTHAR_XDG_CONFIG_HOME="$XDG_CONFIG_HOME"
[ -n "\${XDG_DATA_HOME+x}" ] && export KOTHAR_XDG_DATA_HOME="$XDG_DATA_HOME"
[ -n "\${XDG_STATE_HOME+x}" ] && export KOTHAR_XDG_STATE_HOME="$XDG_STATE_HOME"
export KOTHAR_SHELL="$shell" KOTHAR_OPENCODE_DIR="$dir"
merge=$KOTHAR_OPENCODE_MERGE
unset KOTHAR_OPENCODE_AUTH KOTHAR_OPENCODE_CONFIG KOTHAR_OPENCODE_INSTRUCTIONS KOTHAR_OPENCODE_RESTORE KOTHAR_OPENCODE_MERGE KOTHAR_OPENCODE_SIGNIN
export XDG_CONFIG_HOME="$dir/config" XDG_DATA_HOME="$dir/data" XDG_STATE_HOME="$dir/state" SHELL="$dir/bin/\${shell##*/}"
if [ -n "$merge" ]; then opencode "$@" 2>&1; else opencode "$@"; fi`

// Puts back what LAUNCH moved: each XDG folder as the user had it (unset if it was), and the user's shell.
const XDG = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']
export const RESTORE = [
  ...XDG.map((name) => `if [ -n "\${KOTHAR_${name}+x}" ]; then export ${name}="$KOTHAR_${name}"; else unset ${name}; fi`),
  'export SHELL="$KOTHAR_SHELL"',
  `unset ${XDG.map((name) => `KOTHAR_${name}`).join(' ')} KOTHAR_SHELL`,
  '',
].join('\n')

// Runs an MCP server OpenCode starts with the user's folders back; the folder comes from OpenCode's environment.
const RESTORED_SERVER = '. "$KOTHAR_OPENCODE_DIR/restore.sh" && exec "$@"'

const accountAuthFile = (accountDir: string) => join(accountDir, 'auth.json')
const authFile = (user: UserEnv, accountDir?: string) =>
  accountDir
    ? accountAuthFile(accountDir)
    : join(user.env.XDG_DATA_HOME ?? join(user.home, '.local', 'share'), 'opencode', 'auth.json')

// OpenCode refreshes an OAuth login by writing auth.json in place, through the link.
const jailed = (user: UserEnv, sandbox: Sandbox, accountDir?: string): Sandbox => ({
  ...sandbox,
  writable: [...sandbox.writable, authFile(user, accountDir)],
})

type LaunchOptions = { instructions?: string; accountDir?: string; merge?: boolean; signIn?: boolean }
function launch(config: object, { instructions = '', accountDir, merge = false, signIn = false }: LaunchOptions) {
  return {
    KOTHAR_OPENCODE_CONFIG: JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...config }),
    KOTHAR_OPENCODE_INSTRUCTIONS: instructions,
    KOTHAR_OPENCODE_RESTORE: RESTORE,
    ...(accountDir && { KOTHAR_OPENCODE_AUTH: accountAuthFile(accountDir) }),
    ...(merge && { KOTHAR_OPENCODE_MERGE: '1' }),
    // A sign-in links the account's auth.json before it exists, so OpenCode writes the new login there.
    ...(signIn && { KOTHAR_OPENCODE_SIGNIN: '1' }),
    ...CLEAN_ENV,
  }
}

const BASE_CONFIG = { autoupdate: false, share: 'disabled', snapshot: false, plugin: [] }

// OpenCode names an MCP server's tools <server>_<tool>, with anything but letters, digits, _ and - made _.
const toolPrefix = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, '_') + '_'

const stringIn = (input: any, keys: string[] | undefined) =>
  keys?.map((key) => input?.[key]).find((value): value is string => typeof value === 'string')

function toolOf(servers: string[]) {
  return (call: AcpToolCall) => {
    const name = call.firstTitle ?? call.title ?? 'tool'
    const kind: ToolKind = servers.some((s) => name.startsWith(toolPrefix(s)))
      ? 'mcp'
      : (KINDS[name] ?? kindOfAcp(call.kind))
    const input = call.rawInput ?? {}
    const picked = stringIn(input, SUMMARY_FIELDS[kind])
    const summary = (picked ?? (Object.keys(input).length ? JSON.stringify(input) : (call.title ?? name)))
      .replace(/\s+/g, ' ')
      .trim()
    const named = stringIn(input, ['filePath', 'filepath', 'path']) ?? call.locations[0]
    const path = kind === 'edit' || kind === 'read' || kind === 'search' ? named : undefined
    const command = kind === 'shell' ? stringIn(input, ['command']) : undefined
    return { name, kind, summary, ...(path !== undefined && { path }), ...(command !== undefined && { command }) }
  }
}

// OpenCode sends a call first with only its folder as input, then again once the model has written it.
const hasInput = (call: AcpToolCall) => Object.keys(call.rawInput ?? {}).some((key) => key !== 'cwd')

const unescape = (text: string) => text.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c))
const errorOfLine = (line: string) => {
  if (!ERROR_LINE.test(line)) return undefined
  const found = line.match(ERROR_FIELD)?.[1]
  return found && unescape(found).replace(/^AI_\w+Error: /, '').trim()
}

// The models OpenCode offers, from `opencode models --verbose`: each id on a line, then its JSON.
export function parseModels(stdout: string) {
  const models: { id: string; variants: string[] }[] = []
  let id: string | undefined
  let json = ''
  const flush = () => {
    if (id === undefined) return
    try {
      const info = JSON.parse(json)
      models.push({ id, variants: Object.keys(info?.variants ?? {}) })
    } catch {
      models.push({ id, variants: [] })
    }
  }
  for (const line of stdout.split('\n')) {
    if (/^[^\s{}"[\]]+\/\S+$/.test(line)) {
      flush()
      id = line.trim()
      json = ''
    } else if (id !== undefined) json += line + '\n'
  }
  flush()
  return models
}

// Accounts. OpenCode keeps every provider's login in one auth.json; a Kothar account is an auth.json of its own, in
// the account's folder, linked into each run. `opencode auth login -p <provider> [-m <method>]` adds a login to it,
// reading the key or code from stdin.

// oxlint-disable-next-line no-control-regex -- strips terminal escape codes on purpose
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
const strip = (text: string) => text.replace(ANSI, '').replace(/\r/g, '')

// The key OpenCode takes for any provider without a sign-in of its own; its prompt needs no method.
const API_KEY: AccountMethod = { id: 'api', label: 'API key', kind: 'apiKey' }
const login = (id: string, label: string): AccountMethod => ({ id, label, kind: 'login' })
const key = (id: string): AccountMethod => ({ id, label: 'API key', kind: 'apiKey' })

// The providers with sign-ins built into OpenCode (1.17), by the method labels `-m` takes.
export const PROVIDER_METHODS: Record<string, AccountMethod[]> = {
  openai: [
    login('ChatGPT Pro/Plus (browser)', 'ChatGPT Plus or Pro'),
    login('ChatGPT Pro/Plus (headless)', 'ChatGPT Plus or Pro, with a code'),
    key('Manually enter API Key'),
  ],
  'github-copilot': [login('Login with GitHub Copilot', 'GitHub Copilot, with a code')],
  poe: [login('Login with Poe (browser)', 'Poe'), key('Manually enter API Key')],
  xai: [
    login('xAI Grok OAuth (SuperGrok Subscription)', 'SuperGrok'),
    login('xAI Grok OAuth (Headless / Remote / VPS)', 'SuperGrok, with a code'),
    key('Manually enter API Key'),
  ],
  digitalocean: [login('Login with DigitalOcean', 'DigitalOcean'), key('Paste Model Access Key')],
}

// Providers whose sign-in asks for more than a key (an account, resource or instance id), or that take only cloud
// credentials from the environment: Kothar's dialog can't answer those.
const UNOFFERED = new Set([
  'azure',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'gitlab',
  'snowflake-cortex',
  'google-vertex',
  'google-vertex-anthropic',
])

// Listed first, in this order; also the list when OpenCode's models.dev cache isn't there yet.
const POPULAR: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'github-copilot': 'GitHub Copilot',
  google: 'Google',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  opencode: 'OpenCode Zen',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
}

// The providers OpenCode knows, from its models.dev cache (`{ <id>: { name, ... } }`).
export function parseProviders(json: string): AccountProvider[] {
  let data: Record<string, { name?: unknown }> = {}
  try {
    data = JSON.parse(json) ?? {}
  } catch {}
  const names = new Map(Object.entries(POPULAR))
  for (const [id, info] of Object.entries(data)) {
    if (!names.has(id)) names.set(id, typeof info?.name === 'string' && info.name.trim() ? info.name.trim() : id)
  }
  const popular = Object.keys(POPULAR)
  return [...names]
    .filter(([id]) => !UNOFFERED.has(id))
    .map(([id, name]) => ({
      id,
      name,
      group: popular.includes(id) ? 'Popular' : 'All providers',
      methods: PROVIDER_METHODS[id] ?? [API_KEY],
    }))
    .sort((a, b) => {
      const rank = (p: AccountProvider) => (popular.includes(p.id) ? popular.indexOf(p.id) : popular.length)
      return rank(a) - rank(b) || a.name.localeCompare(b.name)
    })
}

const MODELS_CACHE = 'cat "${XDG_CACHE_HOME:-$HOME/.cache}/opencode/models.json"'

// `-m` only for providers with sign-ins of their own; the rest ask for a key straight away.
const loginArgs = (provider: string, method: string) => [
  'opencode',
  'auth',
  'login',
  '--provider',
  provider,
  ...(method === API_KEY.id ? [] : ['--method', method]),
  ...CLEAN_ARGS,
]

// `opencode auth list`: a line per saved login, `● <provider name> <api|oauth|wellknown>`, then any found in the
// environment, which aren't the account's.
export function parseCredentials(stdout: string) {
  const found: { name: string; type: string }[] = []
  for (const line of strip(stdout).split('\n')) {
    if (/environment/i.test(line) && found.length) break
    const match = line.match(/^\s*[●•]\s+(.+?)\s+(api|oauth|wellknown)\s*$/)
    if (match) found.push({ name: match[1]!, type: match[2]! })
  }
  return found
}

async function authStatus(machine: Machine, accountDir?: string): Promise<AccountStatus> {
  const env = launch(BASE_CONFIG, { accountDir })
  const listed = await machine.run('/bin/sh', ['-c', LAUNCH, 'opencode', 'auth', 'list', ...CLEAN_ARGS], { cwd: '/', env })
  if (listed.code !== 0) return { signedIn: false }
  const found = parseCredentials(listed.stdout)
  if (!found.length) return { signedIn: false }
  const [only] = found
  const label =
    found.length === 1 && only
      ? `${only.name} ${only.type === 'api' ? 'API key' : 'sign-in'}`
      : found.map((c) => c.name).join(', ')
  return { signedIn: true, label }
}

const LOGIN_URL = /Go to:\s*(https?:\/\/\S+)/
const LOGIN_INSTRUCTIONS = /(Enter code:\s*\S+)/
const LOGIN_DONE = /Login successful/
const LOGIN_FAILED = /(Failed to authorize[^\n]*|Unknown (?:method|provider)[^\n]*)/
// GitHub Copilot asks GitHub.com or Enterprise first; Enter takes GitHub.com.
const DEPLOYMENT_PROMPT = /Select GitHub deployment type/
const OUTPUT_TAIL_CHARS = 8000

export function createOpencode(user: UserEnv = processUserEnv()): Adapter {
  return {
    id: 'opencode',
    name: 'OpenCode',
    imageInput: true,
    kotharMcp: true,

    async detect(machine) {
      const options = { cwd: '/' }
      const version = await machine.run('opencode', ['--version'], options).catch(() => null)
      if (version?.code !== 0) return { installed: false, signedIn: false }
      const env = launch(BASE_CONFIG, {})
      const listed = await machine
        .run('/bin/sh', ['-c', LAUNCH, 'opencode', 'models', '--verbose', ...CLEAN_ARGS], { ...options, env })
        .catch(() => null)
      const found = listed?.code === 0 ? parseModels(listed.stdout) : []
      const thinking = [...THINKING_LEVELS]
      const modelThinking: Record<string, ThinkingLevel[]> = {}
      for (const { id, variants } of found) {
        const levels = levelsOfEfforts(variants)
        if (levels.join() !== thinking.join()) modelThinking[id] = levels
      }
      const models = found.map((m) => m.id)
      return {
        installed: true,
        // OpenCode offers some models with no sign-in; it can run whenever it lists one.
        signedIn: models.length > 0,
        detail: version.stdout.trim(),
        models,
        thinking,
        ...(Object.keys(modelThinking).length && { modelThinking }),
      }
    },

    accounts: {
      status: authStatus,

      async providers(machine) {
        const cached = await machine.run('/bin/sh', ['-c', MODELS_CACHE], { cwd: '/' }).catch(() => null)
        return parseProviders(cached?.code === 0 ? cached.stdout : '')
      },

      // A browser or device sign-in: OpenCode prints the link ("Go to:"), maybe a code to type in, then waits for the
      // provider (or for a pasted code) and saves the login through the linked auth.json.
      login(machine, accountDir, emit, choice) {
        const { provider, method } = choice ?? { provider: 'openai', method: 'ChatGPT Pro/Plus (browser)' }
        const env = launch(BASE_CONFIG, { accountDir, merge: true, signIn: true })
        const proc = machine.spawn('/bin/sh', ['-c', LAUNCH, ...loginArgs(provider, method)], { cwd: accountDir, env })
        let output = ''
        let sent = ''
        let answered = false
        proc.onStdout((chunk) => {
          output = (output + chunk).slice(-OUTPUT_TAIL_CHARS)
          const text = strip(output)
          if (!answered && DEPLOYMENT_PROMPT.test(text)) {
            answered = true
            proc.write('\r')
          }
          const url = text.match(LOGIN_URL)?.[1]
          const instructions = text.match(LOGIN_INSTRUCTIONS)?.[1]
          const key = `${url} ${instructions}`
          if (!url || key === sent) return
          sent = key
          // The provider's page finishes the sign-in (a redirect or a device code typed in there); nothing comes back to
          // paste.
          emit({ type: 'url', url, noCode: true, ...(instructions && { instructions }) })
        })
        proc.onExit((code, stderrTail) => {
          const text = strip(output + stderrTail)
          if (code === 0 && LOGIN_DONE.test(text)) return emit({ type: 'done' })
          const error = text.match(LOGIN_FAILED)?.[1]?.trim() ?? `OpenCode sign-in exited with code ${code}`
          emit({ type: 'failed', error })
        })
        return { submitCode: (code) => proc.write(code.trim() + '\r'), cancel: () => proc.kill() }
      },

      // The account's auth.json goes with its folder.
      logout: async () => {},

      // The key goes in on stdin, never in arguments.
      async addApiKey(machine, accountDir, key, choice) {
        const { provider, method } = choice ?? { provider: 'anthropic', method: API_KEY.id }
        const env = launch(BASE_CONFIG, { accountDir, merge: true, signIn: true })
        const args = ['-c', LAUNCH, ...loginArgs(provider, method)]
        const options = { cwd: accountDir, env, input: key + '\r', timeoutMs: 60_000 }
        const { code, stdout } = await machine.run('/bin/sh', args, options)
        const text = strip(stdout)
        const failed = text.match(LOGIN_FAILED)?.[1]
        if (code !== 0 || failed) throw new Error(failed?.trim() ?? `OpenCode exited with code ${code}`)
      },
    },

    async complete(machine, { cwd, system, prompt, schema, model, timeoutMs, accountDir, sandbox }) {
      const instructions = schema
        ? `${system}\n\nReply with only JSON that matches this JSON Schema:\n${JSON.stringify(schema)}`
        : system
      const agent = { mode: 'primary', prompt: instructions, tools: { '*': false } }
      const env = launch({ ...BASE_CONFIG, agent: { title: { disable: true }, [COMPLETE_AGENT]: agent } }, { accountDir })
      const args = ['-c', LAUNCH, 'opencode', 'run', ...CLEAN_ARGS, '--format', 'json', '--agent', COMPLETE_AGENT]
      args.push('--model', model)
      const options = { cwd, env, input: prompt, timeoutMs, ...(sandbox && { sandbox: jailed(user, sandbox, accountDir) }) }
      const { code, stdout, stderr } = await machine.run('/bin/sh', args, options)
      const texts: string[] = []
      let error: string | undefined
      for (const line of stdout.split('\n')) {
        let event: any
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'text' && typeof event.part?.text === 'string') texts.push(event.part.text)
        if (event.type === 'error') error ??= event.error?.data?.message || event.error?.name || 'OpenCode failed'
      }
      if (error) throw new Error(error)
      if (code !== 0) throw new Error(stderr.trim() || `OpenCode exited with code ${code}`)
      return texts.join('')
    },

    start(machine, options, emit) {
      const { cwd, instructions, accountDir, kotharMcp, mcpServers = [], extraDirs = [], model, thinking, sandbox } =
        options
      const servers: AcpMcpServer[] = []
      if (kotharMcp) {
        // In session/new, on OpenCode's stdin, so the token stays out of `ps`.
        const headers = [{ name: 'Authorization', value: `Bearer ${kotharMcp.token}` }]
        servers.push({ type: 'http', name: 'kothar', url: kotharMcp.url, headers })
      }
      for (const server of mcpServers) {
        const restored = { ...server, command: '/bin/sh', args: ['-c', RESTORED_SERVER, server.name, server.command, ...(server.args ?? [])] }
        servers.push(acpStdioServer(restored))
      }
      // Edits, commands, fetches and the extension servers' tools ask; Kothar answers or asks the user.
      const permission: Record<string, unknown> = {
        edit: 'ask',
        bash: 'ask',
        webfetch: 'ask',
        websearch: 'ask',
        external_directory: Object.fromEntries([
          ['*', 'ask'],
          ...extraDirs.flatMap((dir) => [
            [dir, 'allow'],
            [join(dir, '*'), 'allow'],
          ]),
        ]),
      }
      for (const server of mcpServers) permission[`${toolPrefix(server.name)}*`] = server.allowTools ? 'allow' : 'ask'
      const config = {
        ...BASE_CONFIG,
        tools: TOOLS_OFF,
        agent: { title: { disable: true } },
        permission,
        experimental: { mcp_timeout: MCP_CALL_TIMEOUT_MS },
      }
      const dirs = extraDirs.map((dir) => `\n- ${dir}`).join('')
      const text = [instructions, dirs && `You can also work in these folders:${dirs}`].filter(Boolean).join('\n\n')
      const env = launch(config, { instructions: text, accountDir, merge: true })
      const args = ['-c', LAUNCH, 'opencode', ...LOG_ARGS, 'acp', ...CLEAN_ARGS, '--cwd', cwd]
      const proc = machine.spawn('/bin/sh', args, { cwd, env, ...(sandbox && { sandbox: jailed(user, sandbox, accountDir) }) })

      // The latest model-call error this turn with nothing heard since: OpenCode ends such a turn as if it had finished.
      let lastError: string | undefined
      const names = [...(kotharMcp ? ['kothar'] : []), ...mcpServers.map((s) => s.name)]
      const tool = toolOf(names)
      return startAcpSession(
        proc,
        { cwd, mcpServers: servers, ...(model && { model }), ...(thinking && { thinking }), name: 'OpenCode' },
        {
          tool: (call) => {
            lastError = undefined
            return tool(call)
          },
          hasInput,
          turnStarted: () => (lastError = undefined),
          line(line, turn) {
            const error = errorOfLine(line)
            if (!error || !turn.running) return
            lastError = error
            if (LIMIT_ERROR.test(error)) turn.limit(error)
          },
          turnError: () => lastError,
        },
        (event) => {
          if (event.type === 'text.delta' || event.type === 'thinking.delta') lastError = undefined
          emit(event)
        },
      )
    },
  }
}

export const opencode = createOpencode()
