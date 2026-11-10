import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localMachine } from '../machine.ts'
import { type EngineEvent, type SessionOptions } from '../shared.ts'
import { effortFor, levelsOfEfforts } from './acp.ts'
import { opencode, parseCredentials, parseModels, parseProviders } from './opencode.ts'
import { fakeMachine } from './test-machine.ts'

const fixture = (name: string) => readFileSync(new URL(`fixtures/opencode/${name}`, import.meta.url), 'utf8')
const lines = (name: string) => fixture(`${name}.jsonl`).split('\n').filter(Boolean)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const line = (record: unknown) => JSON.stringify(record) + '\n'

const INITIALIZED = line({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: {} } })
const MODEL_OPTIONS = [
  {
    id: 'model',
    category: 'model',
    type: 'select',
    currentValue: 'opencode/big-pickle',
    options: [{ value: 'opencode/big-pickle' }, { value: 'openai/gpt-5.5' }],
  },
  {
    id: 'effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [{ value: 'none' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }],
  },
]
const created = (configOptions: unknown[] = []) =>
  line({ jsonrpc: '2.0', id: 2, result: { sessionId: 'ses_1', configOptions } })

function startSession(extra: Partial<SessionOptions> = {}) {
  const fake = fakeMachine()
  const events: EngineEvent[] = []
  const session = opencode.start(fake.machine, { cwd: '/tmp/project', instructions: 'Be kind.', ...extra }, (e) =>
    events.push(e),
  )
  return { fake, events, session }
}

// A started session whose agent answered initialize and session/new, as the recorded fixtures did.
async function readySession(name: string, extra: Partial<SessionOptions> = {}) {
  const started = startSession(extra)
  const [init, newSession, ...rest] = lines(name)
  started.fake.stdout(init + '\n')
  await tick()
  started.fake.stdout(newSession + '\n')
  await tick()
  return { ...started, rest }
}

const types = (events: EngineEvent[]) => events.map((e) => e.type)
const configOf = (env?: Record<string, string>) => JSON.parse(env?.KOTHAR_OPENCODE_CONFIG ?? '{}')

describe('OpenCode adapter', () => {
  it('runs `opencode acp` clean, through a launch script, logging only errors, in the project folder', () => {
    const { fake } = startSession()
    const [spawned] = fake.spawned
    expect(spawned).toMatchObject({ command: '/bin/sh', cwd: '/tmp/project' })
    expect(spawned?.args[0]).toBe('-c')
    expect(spawned?.args.slice(2)).toEqual([
      'opencode',
      '--print-logs', '--log-level', 'ERROR',
      'acp', '--pure', '--cwd', '/tmp/project',
    ])
    expect(spawned?.env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      KOTHAR_OPENCODE_MERGE: '1',
    })
  })

  it("gives OpenCode Kothar's config: asking for edits, commands and fetches, no subagents, skills or titles", () => {
    const { fake } = startSession()
    const config = configOf(fake.spawned[0]?.env)
    expect(config).toMatchObject({
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
      plugin: [],
      tools: { task: false, skill: false, question: false },
      agent: { title: { disable: true } },
      permission: { edit: 'ask', bash: 'ask', webfetch: 'ask', websearch: 'ask', external_directory: { '*': 'ask' } },
      experimental: { mcp_timeout: 24 * 60 * 60 * 1000 },
    })
    expect(config.mcp).toBeUndefined()
    expect(config.instructions).toBeUndefined()
  })

  it('passes the instructions as the global AGENTS.md of its own config folder, with the extra folders allowed', () => {
    const { fake } = startSession({ extraDirs: ['/other/repo'] })
    const env = fake.spawned[0]?.env
    expect(env?.KOTHAR_OPENCODE_INSTRUCTIONS).toBe('Be kind.\n\nYou can also work in these folders:\n- /other/repo')
    expect(configOf(env).permission.external_directory).toEqual({
      '*': 'ask',
      '/other/repo': 'allow',
      '/other/repo/*': 'allow',
    })
  })

  it("gives OpenCode Kothar's server and the extensions' servers in session/new, the token only on stdin", async () => {
    const token = 'secret-token'
    const { fake } = startSession({
      kotharMcp: { url: 'http://127.0.0.1:4317/mcp', token },
      mcpServers: [
        { name: 'browser', command: 'npx', args: ['@playwright/mcp'], env: { A: '1' } },
        { name: 'my.tools', command: 'tools', allowTools: true },
      ],
    })
    expect(JSON.stringify(fake.spawned[0])).not.toContain(token)
    expect(fake.sent()[0]).toMatchObject({ id: 1, method: 'initialize', params: { protocolVersion: 1 } })
    fake.stdout(INITIALIZED)
    await tick()
    const servers = fake.sent()[1]?.params.mcpServers
    expect(fake.sent()[1]).toMatchObject({ id: 2, method: 'session/new', params: { cwd: '/tmp/project' } })
    expect(servers[0]).toEqual({
      type: 'http',
      name: 'kothar',
      url: 'http://127.0.0.1:4317/mcp',
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    })
    // Started with the user's XDG folders and shell back.
    expect(servers[1]).toMatchObject({ name: 'browser', command: '/bin/sh', env: [{ name: 'A', value: '1' }] })
    expect(servers[1].args.slice(2)).toEqual(['browser', 'npx', '@playwright/mcp'])
    expect(servers[1].args[1]).toContain('restore.sh')
    const permission = configOf(fake.spawned[0]?.env).permission
    expect(permission['browser_*']).toBe('ask')
    expect(permission['my_tools_*']).toBe('allow')
  })

  it('holds a prompt until the session exists, then sends it with its images', async () => {
    const { fake, events, session } = startSession()
    session.prompt('look', [{ mimeType: 'image/png', base64: 'AAAA' }])
    expect(types(events)).toEqual(['turn.started'])
    expect(fake.sent().map((m) => m.method)).toEqual(['initialize'])
    fake.stdout(INITIALIZED)
    await tick()
    fake.stdout(created())
    await tick()
    expect(fake.sent()[2]).toMatchObject({
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'ses_1',
        prompt: [
          { type: 'text', text: 'look' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        ],
      },
    })
  })

  it('picks the model and thinking level through the config options before the first prompt', async () => {
    const { fake, session } = startSession({ model: 'openai/gpt-5.5', thinking: 'off' })
    session.prompt('hi')
    fake.stdout(INITIALIZED)
    await tick()
    fake.stdout(created(MODEL_OPTIONS))
    await tick()
    expect(fake.sent()[2]).toMatchObject({
      method: 'session/set_config_option',
      params: { sessionId: 'ses_1', configId: 'model', value: 'openai/gpt-5.5' },
    })
    fake.stdout(line({ jsonrpc: '2.0', id: 3, result: { configOptions: MODEL_OPTIONS } }))
    await tick()
    // `off` is OpenCode's `none`.
    expect(fake.sent()[3]).toMatchObject({ params: { configId: 'effort', value: 'none' } })
    fake.stdout(line({ jsonrpc: '2.0', id: 4, result: {} }))
    await tick()
    expect(fake.sent()[4]).toMatchObject({ id: 5, method: 'session/prompt' })
  })

  it("fails the turn when OpenCode doesn't offer the model", async () => {
    const { fake, events, session } = startSession({ model: 'nope/model' })
    session.prompt('hi')
    fake.stdout(INITIALIZED)
    await tick()
    fake.stdout(created(MODEL_OPTIONS))
    await tick()
    expect(events.at(-1)).toEqual({ type: 'turn.completed', error: "OpenCode doesn't offer the model nope/model" })
    session.prompt('again')
    expect(events.at(-1)).toEqual({ type: 'turn.completed', error: "OpenCode doesn't offer the model nope/model" })
  })

  it('streams a turn: thinking, text, a command it asks for, its output and the reply', async () => {
    const { fake, events, session, rest } = await readySession('bash-allow')
    session.prompt('hello')
    const [beforeAsk, afterAsk] = [rest.slice(0, 5), rest.slice(5)]
    fake.stdout(beforeAsk.join('\n') + '\n')
    await tick()
    expect(events.slice(1)).toEqual([
      { type: 'thinking.delta', text: 'Thinking about it. ' },
      { type: 'text.delta', text: 'Let me run it.' },
      { type: 'text.completed', text: 'Let me run it.' },
      {
        type: 'tool.started',
        toolId: 'call_1',
        name: 'bash',
        kind: 'shell',
        summary: 'echo hi',
        input: { command: 'echo hi', description: 'Say hi', cwd: '/tmp/project' },
      },
      {
        type: 'permission.requested',
        requestId: 'acp-0',
        toolId: 'call_1',
        name: 'bash',
        kind: 'shell',
        summary: 'echo hi',
        command: 'echo hi',
        input: { command: 'echo hi', description: 'Say hi' },
      },
    ])
    session.respond('acp-0', true)
    expect(fake.sent().at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: { outcome: { outcome: 'selected', optionId: 'once' } },
    })
    fake.stdout(afterAsk.join('\n') + '\n')
    await tick()
    expect(events.slice(6)).toEqual([
      { type: 'tool.completed', toolId: 'call_1', output: 'hi\n', isError: false },
      { type: 'text.delta', text: 'All ' },
      { type: 'text.delta', text: 'done.' },
      { type: 'text.completed', text: 'All done.' },
      { type: 'turn.completed' },
    ])
  })

  it('starts an edit at its permission request, with the file it writes', async () => {
    const { fake, events, session, rest } = await readySession('edit-allow')
    session.prompt('hello')
    fake.stdout(rest.join('\n') + '\n')
    await tick()
    const started = events.find((e) => e.type === 'tool.started')
    const asked = events.find((e) => e.type === 'permission.requested')
    expect(started).toMatchObject({ name: 'write', kind: 'edit', path: '/tmp/project/hello.txt' })
    expect(asked).toMatchObject({ name: 'write', kind: 'edit', path: '/tmp/project/hello.txt' })
    expect(asked && 'input' in asked && asked.input).toMatchObject({ filepath: '/tmp/project/hello.txt' })
    expect(types(events).indexOf('tool.started')).toBeLessThan(types(events).indexOf('permission.requested'))
  })

  it('rejects a denied call; OpenCode ends the turn', async () => {
    const { fake, events, session, rest } = await readySession('bash-reject')
    session.prompt('hello')
    fake.stdout(rest.slice(0, 5).join('\n') + '\n')
    await tick()
    session.respond('acp-0', false)
    expect(fake.sent().at(-1)?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
    fake.stdout(rest.slice(5).join('\n') + '\n')
    await tick()
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ isError: true })
    expect(events.at(-1)).toEqual({ type: 'turn.completed' })
  })

  it('interrupts with session/cancel, cancelling the open permission request, and ends the turn as interrupted', async () => {
    const { fake, events, session, rest } = await readySession('bash-cancel')
    session.prompt('hello')
    fake.stdout(rest.slice(0, 5).join('\n') + '\n')
    await tick()
    session.interrupt()
    expect(fake.sent().slice(-2)).toEqual([
      { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'cancelled' } } },
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: JSON.parse(lines('bash-cancel')[1]!).result.sessionId } },
    ])
    // A late answer to the cancelled request goes nowhere.
    session.respond('acp-0', true)
    expect(fake.sent()).toHaveLength(5)
    // OpenCode answers the prompt with end_turn.
    fake.stdout(rest.slice(5).join('\n') + '\n')
    await tick()
    expect(events.at(-1)).toEqual({ type: 'turn.completed', error: 'Interrupted' })
  })

  it('ends a turn that is interrupted before the session exists without sending it', async () => {
    const { fake, events, session } = startSession()
    session.prompt('hello')
    session.interrupt()
    expect(events.at(-1)).toEqual({ type: 'turn.completed', error: 'Interrupted' })
    fake.stdout(INITIALIZED)
    await tick()
    fake.stdout(created())
    await tick()
    expect(fake.sent().map((m) => m.method)).toEqual(['initialize', 'session/new'])
  })

  it("classes OpenCode's tools and MCP tools by name", async () => {
    const { fake, events, session } = startSession({ kotharMcp: { url: 'http://x/mcp', token: 't' } })
    fake.stdout(INITIALIZED)
    await tick()
    fake.stdout(created())
    await tick()
    session.prompt('hi')
    const call = (toolCallId: string, title: string, rawInput: object, kind = 'other') =>
      line({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'ses_1', update: { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending', rawInput } },
      }) +
      line({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'ses_1', update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawInput, content: [] } },
      })
    fake.stdout(
      call('a', 'kothar_zoom', { id: 3 }) +
        call('b', 'read', { filePath: '/tmp/project/a.ts' }, 'read') +
        call('c', 'grep', { pattern: 'TODO', path: '/tmp/project' }, 'search') +
        call('d', 'webfetch', { url: 'https://example.com' }, 'fetch') +
        call('e', 'todowrite', { todos: [] }),
    )
    await tick()
    const started = events.filter((e) => e.type === 'tool.started')
    expect(started.map((e) => e.type === 'tool.started' && [e.name, e.kind, e.summary, e.path])).toEqual([
      ['kothar_zoom', 'mcp', '{"id":3}', undefined],
      ['read', 'read', '/tmp/project/a.ts', '/tmp/project/a.ts'],
      ['grep', 'search', 'TODO', '/tmp/project'],
      ['webfetch', 'fetch', 'https://example.com', undefined],
      ['todowrite', 'other', '{"todos":[]}', undefined],
    ])
  })

  it("reports the account's usage limit once, from OpenCode's error log, while it retries", async () => {
    const { fake, events, session } = startSession()
    fake.stdout(INITIALIZED)
    await tick()
    fake.stdout(created())
    await tick()
    const [limit] = fixture('log-lines.txt').split('\n')
    fake.stdout(limit + '\n')
    expect(events).toEqual([])
    session.prompt('hi')
    fake.stdout(limit + '\n' + limit + '\n')
    expect(events.slice(1)).toEqual([
      { type: 'limit.reached', message: 'You exceeded your current quota, please check your plan' },
    ])
  })

  it("ends a turn OpenCode ended silently with the error it logged, but not one it got past", async () => {
    const [, broken, warning, other] = fixture('log-lines.txt').split('\n')
    const { fake, events, session } = startSession()
    fake.stdout(INITIALIZED)
    await tick()
    fake.stdout(created())
    await tick()
    session.prompt('hi')
    fake.stdout([warning, other, broken].join('\n') + '\n')
    fake.stdout(line({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } }))
    await tick()
    expect(events.slice(1)).toEqual([{ type: 'turn.completed', error: 'The model is broken' }])
    session.prompt('again')
    fake.stdout(broken + '\n')
    fake.stdout(
      line({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'ses_1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } },
      }),
    )
    fake.stdout(line({ jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn' } }))
    await tick()
    expect(events.at(-1)).toEqual({ type: 'turn.completed' })
  })

  it('fails the turn with a JSON-RPC error, and turns down requests for files and terminals', async () => {
    const { fake, events, session } = startSession()
    fake.stdout(INITIALIZED)
    await tick()
    fake.stdout(created())
    await tick()
    session.prompt('hi')
    fake.stdout(line({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: { path: '/etc/hosts' } }))
    expect(fake.sent().at(-1)).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found: fs/read_text_file' } })
    fake.stdout(line({ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'Internal error', data: { message: 'disk full' } } }))
    await tick()
    expect(events.at(-1)).toEqual({ type: 'turn.completed', error: 'Internal error: disk full' })
  })

  it('ends the session, with the last log lines when OpenCode fails, or quietly when closed', async () => {
    const failing = startSession()
    failing.session.prompt('hi')
    failing.fake.stdout('Error: config is invalid\n')
    failing.fake.exit(1)
    await tick()
    expect(failing.events.slice(1)).toEqual([
      { type: 'turn.completed', error: 'Error: config is invalid' },
      { type: 'session.ended', error: 'Error: config is invalid' },
    ])
    const closing = startSession()
    closing.session.close()
    expect(closing.fake.state).toEqual({ stdinClosed: true, killed: true })
    closing.fake.exit(143)
    expect(closing.events).toEqual([{ type: 'session.ended' }])
  })
})

describe('OpenCode models and thinking levels', () => {
  it('reads the models and their effort variants from `opencode models --verbose`', () => {
    expect(parseModels(fixture('models-verbose.txt'))).toEqual([
      { id: 'opencode/big-pickle', variants: [] },
      { id: 'openai/gpt-5.5', variants: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
      { id: 'anthropic/claude-sonnet-5-5', variants: ['high', 'max'] },
      { id: 'openrouter/deepseek/deepseek-v4', variants: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
    ])
  })

  it("maps Kothar's levels to OpenCode's variants", () => {
    expect(levelsOfEfforts(['none', 'minimal', 'medium'])).toEqual(['off', 'low', 'medium'])
    expect(effortFor('low', ['minimal', 'low'])).toBe('low')
    expect(effortFor('low', ['minimal'])).toBe('minimal')
    expect(effortFor('xhigh', ['high'])).toBeUndefined()
  })

  it('detects OpenCode, its models and the levels each takes', async () => {
    const fake = fakeMachine({
      'opencode --version': { code: 0, stdout: '1.17.9\n', stderr: '' },
      '/bin/sh': { code: 0, stdout: fixture('models-verbose.txt'), stderr: '' },
    })
    expect(await opencode.detect(fake.machine)).toEqual({
      installed: true,
      signedIn: true,
      detail: '1.17.9',
      models: ['opencode/big-pickle', 'openai/gpt-5.5', 'anthropic/claude-sonnet-5-5', 'openrouter/deepseek/deepseek-v4'],
      thinking: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      modelThinking: {
        'opencode/big-pickle': [],
        'openai/gpt-5.5': ['off', 'low', 'medium', 'high', 'xhigh'],
        'anthropic/claude-sonnet-5-5': ['high', 'max'],
      },
    })
    expect(fake.ran[1]?.args.slice(2)).toEqual(['opencode', 'models', '--verbose', '--pure'])
  })

  it('reports not installed, and not signed in when it lists no models', async () => {
    expect(await opencode.detect(fakeMachine().machine)).toEqual({ installed: false, signedIn: false })
    const empty = fakeMachine({ 'opencode --version': { code: 0, stdout: '1.17.9', stderr: '' } })
    expect(await opencode.detect(empty.machine)).toMatchObject({ installed: true, signedIn: false, models: [] })
  })
})

describe('OpenCode one-shot completions', () => {
  const json = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'

  it('runs `opencode run` with an agent of its own: the system prompt and no tools', async () => {
    const stdout = json([
      { type: 'step_start', part: {} },
      { type: 'text', part: { type: 'text', text: 'A summary' } },
      { type: 'step_finish', part: {} },
    ])
    const fake = fakeMachine({ '/bin/sh': { code: 0, stdout, stderr: '' } })
    const reply = await opencode.complete!(fake.machine, {
      cwd: '/work/home',
      system: 'Summarize.',
      prompt: 'the messages',
      schema: { type: 'object' },
      model: 'openai/gpt-5.5',
      timeoutMs: 1000,
    })
    expect(reply).toBe('A summary')
    const [ran] = fake.ran
    expect(ran?.args.slice(2)).toEqual([
      'opencode', 'run', '--pure', '--format', 'json', '--agent', 'kothar-complete', '--model', 'openai/gpt-5.5',
    ])
    expect(ran?.input).toBe('the messages')
    const agent = configOf(ran?.env).agent['kothar-complete']
    expect(agent).toMatchObject({ mode: 'primary', tools: { '*': false } })
    expect(agent.prompt).toMatch(/^Summarize\.\n\nReply with only JSON that matches this JSON Schema:\n\{"type":"object"\}$/)
  })

  it("throws OpenCode's error", async () => {
    const stdout = json([{ type: 'error', error: { name: 'APIError', data: { message: 'quota exceeded' } } }])
    const fake = fakeMachine({ '/bin/sh': { code: 1, stdout, stderr: '' } })
    const request = { cwd: '/', system: 's', prompt: 'p', model: 'm/m', timeoutMs: 1 }
    await expect(opencode.complete!(fake.machine, request)).rejects.toThrow('quota exceeded')
  })
})

describe('OpenCode in a sandbox', () => {
  const sandbox = { writable: ['/work/space'], tmpDir: '/work/space/.tmp' }
  const saved = process.env.XDG_DATA_HOME
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = saved
  })

  it('also lets it write its login, which it refreshes in place', () => {
    delete process.env.XDG_DATA_HOME
    const { fake } = startSession({ sandbox })
    const login = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
    expect(fake.spawned[0]?.sandbox).toEqual({ writable: ['/work/space', login], tmpDir: sandbox.tmpDir })
    const account = startSession({ sandbox, accountDir: '/garage/accounts/opencode/a1' })
    expect(account.fake.spawned[0]?.sandbox?.writable).toEqual(['/work/space', '/garage/accounts/opencode/a1/auth.json'])
    expect(account.fake.spawned[0]?.env?.KOTHAR_OPENCODE_AUTH).toBe('/garage/accounts/opencode/a1/auth.json')
  })
})

describe("OpenCode's own folders", () => {
  const saved = { PATH: process.env.PATH, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, SHELL: process.env.SHELL }
  let root = ''
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  it("makes them per run with Kothar's config and the login linked, gives commands the user's back, and removes them", async () => {
    root = mkdtempSync(join(tmpdir(), 'kothar-opencode-test-'))
    const bin = join(root, 'bin')
    const data = join(root, 'data')
    const project = join(root, 'project')
    for (const dir of [bin, join(data, 'opencode'), project]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(data, 'opencode', 'auth.json'), '{}')
    // A stand-in for OpenCode: records its folders, then runs a command the way its bash tool does, through $SHELL.
    writeFileSync(
      join(bin, 'opencode'),
      '#!/bin/sh\nout=$PWD\necho "$XDG_CONFIG_HOME" > "$out/config-dir"\n' +
        'cp "$XDG_CONFIG_HOME/opencode/opencode.json" "$XDG_CONFIG_HOME/opencode/AGENTS.md" "$out/"\n' +
        'readlink "$XDG_DATA_HOME/opencode/auth.json" > "$out/auth-link"\n' +
        '"$SHELL" -c \'echo "${XDG_CONFIG_HOME-unset} ${XDG_DATA_HOME-unset} $SHELL ${KOTHAR_SHELL-gone}"\' > "$out/command-env"\n' +
        'echo "$@" > "$out/args"\n',
    )
    chmodSync(join(bin, 'opencode'), 0o755)
    process.env.PATH = `${bin}:${process.env.PATH}`
    process.env.XDG_DATA_HOME = data
    delete process.env.XDG_CONFIG_HOME
    process.env.SHELL = '/bin/sh'
    const ended = new Promise<EngineEvent>((resolve) =>
      opencode.start(localMachine, { cwd: project, instructions: 'Be kind.' }, (e) => e.type === 'session.ended' && resolve(e)),
    )
    expect(await ended).toEqual({ type: 'session.ended' })
    const read = (name: string) => readFileSync(join(project, name), 'utf8')
    expect(read('AGENTS.md')).toBe('Be kind.')
    expect(JSON.parse(read('opencode.json')).permission.bash).toBe('ask')
    expect(read('auth-link').trim()).toBe(join(data, 'opencode', 'auth.json'))
    expect(read('command-env').trim()).toBe(`unset ${data} /bin/sh gone`)
    expect(read('args').trim()).toBe(`--print-logs --log-level ERROR acp --pure --cwd ${project}`)
    expect(existsSync(read('config-dir').trim())).toBe(false)
  })
})

describe('OpenCode accounts', () => {
  const accounts = opencode.accounts!
  const dir = '/garage/accounts/opencode/work'
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' })

  it('offers the providers in its models.dev cache, popular ones first, each with the ways OpenCode signs in', async () => {
    const cache = JSON.stringify({
      zeta: { name: 'Zeta AI' },
      openai: { name: 'OpenAI' },
      azure: { name: 'Azure' },
      alpha: {},
      anthropic: { name: 'Anthropic' },
    })
    const providers = parseProviders(cache)
    const ids = providers.map((p) => p.id)
    expect(ids.slice(0, 3)).toEqual(['anthropic', 'openai', 'github-copilot'])
    expect(ids).not.toContain('azure')
    expect(ids.slice(-2)).toEqual(['alpha', 'zeta'])
    expect(providers.find((p) => p.id === 'zeta')).toEqual({
      id: 'zeta',
      name: 'Zeta AI',
      group: 'All providers',
      methods: [{ id: 'api', label: 'API key', kind: 'apiKey' }],
    })
    expect(providers.find((p) => p.id === 'openai')?.methods.map((m) => [m.id, m.kind])).toEqual([
      ['ChatGPT Pro/Plus (browser)', 'login'],
      ['ChatGPT Pro/Plus (headless)', 'login'],
      ['Manually enter API Key', 'apiKey'],
    ])
    expect(parseProviders('not json').map((p) => p.group)).toEqual(Array(10).fill('Popular'))

    const fake = fakeMachine({ '/bin/sh': ok(cache) })
    expect((await accounts.providers!(fake.machine)).map((p) => p.id)).toEqual(ids)
    expect(fake.ran[0]?.args.join(' ')).toMatch(/opencode\/models\.json/)
  })

  it("reads an account's logins from `opencode auth list`, not the ones in the environment", async () => {
    const listed = fixture('auth-list.txt')
    expect(parseCredentials(listed)).toEqual([
      { name: 'OpenRouter', type: 'api' },
      { name: 'OpenAI', type: 'api' },
    ])
    const fake = fakeMachine({ '/bin/sh': ok(listed) })
    expect(await accounts.status(fake.machine, dir)).toEqual({ signedIn: true, label: 'OpenRouter, OpenAI' })
    expect(fake.ran[0]?.args.slice(2)).toEqual(['opencode', 'auth', 'list', '--pure'])
    expect(fake.ran[0]?.env?.KOTHAR_OPENCODE_AUTH).toBe(`${dir}/auth.json`)
    expect(fake.ran[0]?.env?.KOTHAR_OPENCODE_SIGNIN).toBeUndefined()

    const one = listed.replace(/.*OpenRouter.*\n/, '')
    expect(await accounts.status(fakeMachine({ '/bin/sh': ok(one) }).machine, dir)).toEqual({
      signedIn: true,
      label: 'OpenAI API key',
    })
    const none = '┌  Credentials ~/auth.json\n│\n└  0 credentials\n'
    expect(await accounts.status(fakeMachine({ '/bin/sh': ok(none) }).machine, dir)).toEqual({ signedIn: false })
  })

  it('adds a key with `opencode auth login`, the key only on stdin, into the account’s own auth.json', async () => {
    const fake = fakeMachine({ '/bin/sh': ok(fixture('login-api-key.txt')) })
    await accounts.addApiKey!(fake.machine, dir, 'sk-test-1', { provider: 'openai', method: 'Manually enter API Key' })
    const run = fake.ran[0]!
    expect(run.args.slice(2)).toEqual([
      'opencode',
      'auth',
      'login',
      '--provider',
      'openai',
      '--method',
      'Manually enter API Key',
      '--pure',
    ])
    expect(run.input).toBe('sk-test-1\r')
    expect(JSON.stringify([run.args, run.env])).not.toContain('sk-test-1')
    expect(run.env).toMatchObject({ KOTHAR_OPENCODE_AUTH: `${dir}/auth.json`, KOTHAR_OPENCODE_SIGNIN: '1' })

    const plain = fakeMachine({ '/bin/sh': ok('') })
    await accounts.addApiKey!(plain.machine, dir, 'sk-test-2', { provider: 'groq', method: 'api' })
    expect(plain.ran[0]?.args.slice(2)).toEqual(['opencode', 'auth', 'login', '--provider', 'groq', '--pure'])

    const refused = fakeMachine({ '/bin/sh': { code: 1, stdout: fixture('login-unknown.txt'), stderr: '' } })
    const adding = accounts.addApiKey!(refused.machine, dir, 'sk-test-3', { provider: 'nope-provider', method: 'api' })
    await expect(adding).rejects.toThrow('Unknown provider "nope-provider"')
  })

  it('signs in through the browser: the link and any code to enter, then done once OpenCode saved it', () => {
    const fake = fakeMachine()
    const events: unknown[] = []
    const flow = accounts.login(fake.machine, dir, (e) => events.push(e), {
      provider: 'openai',
      method: 'ChatGPT Pro/Plus (browser)',
    })
    expect(fake.spawned[0]?.args.slice(2)).toEqual([
      'opencode',
      'auth',
      'login',
      '--provider',
      'openai',
      '--method',
      'ChatGPT Pro/Plus (browser)',
      '--pure',
    ])
    expect(fake.spawned[0]?.env).toMatchObject({ KOTHAR_OPENCODE_SIGNIN: '1', KOTHAR_OPENCODE_MERGE: '1' })
    fake.stdout(fixture('login-browser.txt'))
    fake.stdout('◐  Waiting for authorization')
    const url = expect.stringMatching(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/)
    expect(events).toEqual([{ type: 'url', url, noCode: true }])
    fake.stdout('│\n◇  Login successful\n')
    fake.exit(0)
    expect(events.at(-1)).toEqual({ type: 'done' })
    flow.cancel()
    expect(fake.state.killed).toBe(true)
  })

  it('answers GitHub Copilot’s deployment question, passes on the device code, and reports a failed sign-in', () => {
    const fake = fakeMachine()
    const events: any[] = []
    const flow = accounts.login(fake.machine, dir, (e) => events.push(e), {
      provider: 'github-copilot',
      method: 'Login with GitHub Copilot',
    })
    fake.stdout('┌  Add credential\n│\n◆  Select GitHub deployment type\n│  ● GitHub.com (Public)\n')
    expect(fake.written()).toBe('\r')
    fake.stdout('│\n●  Go to: https://github.com/login/device\n│\n●  Enter code: AB12-CD34\n')
    expect(events).toEqual([
      { type: 'url', url: 'https://github.com/login/device', noCode: true, instructions: 'Enter code: AB12-CD34' },
    ])
    flow.submitCode(' code-1 ')
    expect(fake.written()).toBe('\rcode-1\r')
    fake.stdout('■  Failed to authorize\n')
    fake.exit(1)
    expect(events.at(-1)).toEqual({ type: 'failed', error: 'Failed to authorize' })
  })
})

describe("OpenCode's sign-in folders", () => {
  const accounts = () => opencode.accounts!
  const saved = process.env.PATH
  let root = ''
  afterEach(() => {
    process.env.PATH = saved
    rmSync(root, { recursive: true, force: true })
  })

  it('links a new account’s auth.json before it exists, so OpenCode writes the login into the account folder', async () => {
    root = mkdtempSync(join(tmpdir(), 'kothar-opencode-signin-'))
    const bin = join(root, 'bin')
    const account = join(root, 'account')
    for (const folder of [bin, account]) mkdirSync(folder, { recursive: true })
    // A stand-in for `opencode auth login`: reads the key and writes it the way OpenCode does, to its data folder.
    writeFileSync(
      join(bin, 'opencode'),
      '#!/bin/sh\nread key\nkey=$(printf %s "$key" | tr -d \'\\r\')\nprintf \'{"groq":{"type":"api","key":"%s"}}\' "$key" > "$XDG_DATA_HOME/opencode/auth.json"\n',
    )
    chmodSync(join(bin, 'opencode'), 0o755)
    process.env.PATH = `${bin}:${process.env.PATH}`
    await accounts().addApiKey!(localMachine, account, 'sk-local', { provider: 'groq', method: 'api' })
    expect(JSON.parse(readFileSync(join(account, 'auth.json'), 'utf8'))).toEqual({ groq: { type: 'api', key: 'sk-local' } })
  })
})
