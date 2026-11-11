import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localMachine } from '../machine.ts'
import { type EngineEvent, type SessionOptions } from '../shared.ts'
import { codex, commandOf, createCodex, configOf, envKeyNote, KEYCHAIN_NOTE } from './codex.ts'
import { fakeMachine } from './test-machine.ts'

// Fixtures are real codex-cli 0.167 app-server output, recorded against a local stand-in for the model API (no model
// ran), from the turn on; the test answers the adapter's own requests.
const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/codex/${name}.jsonl`, import.meta.url), 'utf8').split('\n').filter(Boolean)

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function startSession(extra: Partial<SessionOptions> = {}, answers: { skills?: unknown[]; threadId?: string; turnId?: string } = {}) {
  const fake = fakeMachine()
  const events: EngineEvent[] = []
  const session = codex.start(fake.machine, { cwd: '/tmp/project', instructions: 'Be brief.', ...extra }, (e) => events.push(e))
  let answered = 0
  const results: Record<string, (params: any) => unknown> = {
    initialize: () => ({ userAgent: 'test' }),
    'skills/list': () => ({ data: [{ cwd: '/tmp/project', skills: answers.skills ?? [] }] }),
    'skills/config/write': () => ({ effectiveEnabled: false }),
    'thread/start': () => ({ thread: { id: answers.threadId ?? 'thread-1' } }),
    'turn/start': () => ({ turn: { id: answers.turnId ?? 'turn-1', status: 'inProgress' } }),
    'turn/steer': (params) => ({ turnId: params.expectedTurnId }),
    'turn/interrupt': () => ({}),
  }
  // Answers every request the adapter has sent so far, until it sends no more.
  const pump = async () => {
    for (let round = 0; round < 20; round++) {
      await tick()
      const requests = fake.sent().filter((m) => m.method !== undefined && m.id !== undefined)
      if (answered === requests.length) return
      for (const request of requests.slice(answered)) {
        const result = results[request.method]?.(request.params) ?? {}
        fake.stdout(JSON.stringify({ id: request.id, result }) + '\n')
      }
      answered = requests.length
    }
  }
  const sent = (method: string) => fake.sent().filter((m) => m.method === method)
  const config = () => fake.spawned[0]!.env!.KOTHAR_CODEX_CONFIG!
  return { fake, events, session, pump, sent, config }
}

// A turn replayed from a fixture: the thread and turn ids its messages name.
async function replay(name: string, extra: Partial<SessionOptions> = {}, before?: (s: ReturnType<typeof startSession>) => void) {
  const lines = fixture(name)
  const started = JSON.parse(lines.find((l) => l.includes('"turn/started"'))!).params
  const s = startSession(extra, { threadId: started.threadId, turnId: started.turn.id })
  await s.pump()
  s.session.prompt('hi')
  await s.pump()
  before?.(s)
  return { ...s, lines, turnId: started.turn.id as string, feed: (from = 0, to = lines.length) => {
    for (const line of lines.slice(from, to)) s.fake.stdout(line + '\n')
  } }
}

const types = (events: EngineEvent[]) => events.map((e) => e.type)

describe('codex adapter', () => {
  it('runs codex app-server through the launcher in the session folder, with its config and login only in its env', () => {
    const { fake, config } = startSession({ kotharMcp: { url: 'http://127.0.0.1:4317/mcp', token: 'secret-token' } })
    const [spawned] = fake.spawned
    expect(spawned).toMatchObject({ command: '/bin/sh', cwd: '/tmp/project' })
    expect(spawned!.args[0]).toBe('-c')
    expect(spawned!.args.slice(2)).toEqual(['codex', 'app-server'])
    expect(spawned!.env?.KOTHAR_CODEX_LOGIN).toBeTruthy()
    expect(spawned!.env?.KOTHAR_MCP_TOKEN).toBe('secret-token')
    expect(config()).not.toContain('secret-token')
    expect(spawned!.args.join(' ')).not.toContain('secret-token')
    expect(spawned!.env?.KOTHAR_CODEX_AUTH).toBeUndefined()
  })

  it("uses the account's folder for its login, and an API key account's key as its own auth.json", () => {
    const account = startSession({ accountDir: '/garage/accounts/codex/work' }).fake.spawned[0]!
    expect(account.env?.KOTHAR_CODEX_LOGIN).toBe('/garage/accounts/codex/work')
    const keyed = startSession({ accountDir: '/garage/accounts/codex/key', apiKey: 'sk-test' }).fake.spawned[0]!
    expect(JSON.parse(keyed.env!.KOTHAR_CODEX_AUTH!)).toEqual({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' })
  })

  it('writes a clean config: no AGENTS.md, plugins, hooks, memories or its own sub-agents, and exactly Kothar\'s MCP servers', () => {
    const kotharMcp = { url: 'http://127.0.0.1:4317/mcp', token: 't' }
    const mcpServers = [
      { name: 'browser', command: '/bin/node', args: ['cli.js'], env: { TMPDIR: '/t' }, allowTools: true },
      { name: 'bare', command: 'tool' },
    ]
    const config = configOf({ kotharMcp, mcpServers })
    expect(config).toContain('project_doc_max_bytes = 0')
    for (const feature of ['memories', 'plugins', 'apps', 'hooks', 'multi_agent']) expect(config).toContain(`\n${feature} = false`)
    expect(config).toMatch(/\[features\.multi_agent_v2\]\ndisable_native_tools = true/)
    // Without these Codex still tells the model it's one of "a team of agents" that may delegate.
    expect(config).toMatch(/\nroot_agent_usage_hint_text = ""\nmulti_agent_mode_hint_text = ""\n/)
    expect(config).toMatch(/\[skills\.bundled\]\nenabled = false/)
    expect(config).toContain('[mcp_servers."kothar"]\nurl = "http://127.0.0.1:4317/mcp"\nbearer_token_env_var = "KOTHAR_MCP_TOKEN"')
    expect(config).toContain('[mcp_servers."browser"]\ncommand = "/bin/node"\nargs = ["cli.js"]\nenv = { "TMPDIR" = "/t" }')
    // Only servers Kothar lets run unasked skip Codex's approval.
    const approval = (name: string) => config.split(`[mcp_servers."${name}"]`)[1]!.match(/default_tools_approval_mode = "(\w+)"/)![1]
    expect([approval('kothar'), approval('browser'), approval('bare')]).toEqual(['approve', 'approve', 'prompt'])
    expect(config.match(/tool_timeout_sec = (\d+)/)![1]).toBe(String(24 * 60 * 60))
    expect(configOf({})).not.toContain('mcp_servers')
  })

  it('switches off every skill Codex found, then starts an ephemeral thread with the instructions as developer instructions', async () => {
    const skills = [
      { name: 'dash', path: '/home/u/.agents/skills/dash/SKILL.md', enabled: true },
      { name: 'off', path: '/home/u/.agents/skills/off/SKILL.md', enabled: false },
    ]
    const s = startSession({ extraDirs: ['/tmp/other'], model: 'gpt-6-luna' }, { skills })
    await s.pump()
    expect(s.fake.sent().map((m) => m.method)).toEqual([
      'initialize',
      'initialized',
      'skills/list',
      'skills/config/write',
      'thread/start',
    ])
    expect(s.sent('skills/config/write')[0].params).toEqual({ path: skills[0]!.path, enabled: false })
    const [{ params }] = s.sent('thread/start')
    expect(params).toMatchObject({ cwd: '/tmp/project', model: 'gpt-6-luna', approvalPolicy: 'untrusted', ephemeral: true })
    expect(params.developerInstructions).toBe('Be brief.\n\nYou can also work in these folders:\n- /tmp/other')
  })

  it("lets Kothar's sandbox do the jailing, and Codex's own workspace sandbox only without it", async () => {
    const jailed = startSession({ sandbox: { writable: ['/tmp/project'] }, extraDirs: ['/tmp/other'] })
    await jailed.pump()
    expect(jailed.sent('thread/start')[0].params.sandbox).toBe('danger-full-access')
    expect(jailed.config()).not.toContain('sandbox_workspace_write')
    expect(jailed.fake.spawned[0]!.sandbox!.writable).toContain(join(jailed.fake.spawned[0]!.env!.KOTHAR_CODEX_LOGIN!, 'auth.json*'))
    const free = startSession({ extraDirs: ['/tmp/other'] })
    await free.pump()
    expect(free.sent('thread/start')[0].params.sandbox).toBe('workspace-write')
    expect(free.config()).toContain('[sandbox_workspace_write]\nwritable_roots = ["/tmp/other"]')
  })

  it('starts a turn with the text, images as data URLs, the model and the thinking level as effort', async () => {
    const s = startSession({ model: 'gpt-6-luna', thinking: 'off' })
    await s.pump()
    s.session.prompt('look', [{ mimeType: 'image/png', base64: 'AAAA' }])
    expect(s.events).toEqual([{ type: 'turn.started' }])
    await s.pump()
    expect(s.sent('turn/start')[0].params).toEqual({
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'look', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,AAAA' },
      ],
      model: 'gpt-6-luna',
      effort: 'none',
    })
  })

  it('streams thinking and text, and completes the turn', async () => {
    const s = await replay('text')
    s.feed()
    expect(s.events).toEqual([
      { type: 'turn.started' },
      { type: 'thinking.delta', text: 'Thinking it over' },
      ...['Hell', 'o fr', 'om t', 'he m', 'ock.'].map((text) => ({ type: 'text.delta', text })),
      { type: 'text.completed', text: 'Hello from the mock.' },
      { type: 'turn.completed' },
    ])
  })

  it("asks before a command with the command itself, not Codex's shell around it, and runs it when allowed", async () => {
    const s = await replay('tool-allowed')
    const at = s.lines.findIndex((l) => l.includes('requestApproval'))
    s.feed(0, at + 1)
    const asked = s.events.find((e) => e.type === 'permission.requested')
    expect(asked).toMatchObject({ requestId: 'codex-0', name: 'shell', kind: 'shell', command: 'touch made.txt && echo made' })
    const started = s.events.find((e) => e.type === 'tool.started')
    expect(started).toMatchObject({ kind: 'shell', summary: 'touch made.txt && echo made' })
    expect((asked as any).toolId).toBe((started as any).toolId)
    s.session.respond('codex-0', true)
    expect(s.fake.sent().at(-1)).toEqual({ id: 0, result: { decision: 'accept' } })
    s.feed(at + 1)
    expect(s.events.find((e) => e.type === 'tool.completed')).toMatchObject({ output: 'made\n', isError: false })
    expect(types(s.events).at(-1)).toBe('turn.completed')
    expect((s.events.at(-1) as any).error).toBeUndefined()
  })

  it('declines a denied command, which then shows as failed', async () => {
    const s = await replay('tool-denied')
    const at = s.lines.findIndex((l) => l.includes('requestApproval'))
    s.feed(0, at + 1)
    s.session.respond('codex-0', false)
    expect(s.fake.sent().at(-1)).toEqual({ id: 0, result: { decision: 'decline' } })
    s.feed(at + 1)
    expect(s.events.find((e) => e.type === 'tool.completed')).toMatchObject({ isError: true })
  })

  it("names a patch's file outside the folder when it asks, so allowing edits in the folder can't let it through", async () => {
    const s = await replay('patch')
    s.feed(0, s.lines.findIndex((l) => l.includes('requestApproval')) + 1)
    expect(s.events.find((e) => e.type === 'permission.requested')).toMatchObject({
      name: 'apply_patch',
      kind: 'edit',
      path: '/tmp/outside/out.txt',
    })
    expect(s.events.find((e) => e.type === 'tool.started')).toMatchObject({ kind: 'edit', name: 'apply_patch' })
  })

  it('picks the outside file whatever order the patch lists its files in', async () => {
    const s = startSession()
    await s.pump()
    s.session.prompt('hi')
    await s.pump()
    const changes = [
      { path: '/tmp/project/a.txt', kind: { type: 'add' }, diff: '' },
      { path: '/tmp/project/../escape.txt', kind: { type: 'add' }, diff: '' },
      { path: '/etc/b.txt', kind: { type: 'add' }, diff: '' },
    ]
    const item = { type: 'fileChange', id: 'p1', changes, status: 'inProgress' }
    s.fake.stdout(JSON.stringify({ method: 'item/started', params: { turnId: 'turn-1', item } }) + '\n')
    s.fake.stdout(JSON.stringify({ id: 3, method: 'item/fileChange/requestApproval', params: { turnId: 'turn-1', itemId: 'p1' } }) + '\n')
    expect(s.events.at(-1)).toMatchObject({ type: 'permission.requested', path: '/tmp/project/../escape.txt' })
    const inside = startSession()
    await inside.pump()
    inside.session.prompt('hi')
    await inside.pump()
    const only = { ...item, changes: [changes[0]] }
    inside.fake.stdout(JSON.stringify({ method: 'item/started', params: { turnId: 'turn-1', item: only } }) + '\n')
    inside.fake.stdout(JSON.stringify({ id: 3, method: 'item/fileChange/requestApproval', params: { turnId: 'turn-1', itemId: 'p1' } }) + '\n')
    expect(inside.events.at(-1)).toMatchObject({ path: '/tmp/project/a.txt' })
  })

  it('reports a usage limit before the failed turn, so account rotation can switch', async () => {
    const s = await replay('usage-limit')
    s.feed()
    expect(types(s.events)).toEqual(['turn.started', 'limit.reached', 'turn.completed'])
    expect((s.events[1] as any).message).toMatch(/usage limit/)
    expect((s.events[2] as any).error).toMatch(/usage limit/)
  })

  it('takes the limit from codexErrorInfo even when the message says nothing of limits', async () => {
    const s = await replay('text')
    s.fake.stdout(JSON.stringify({ method: 'turn/started', params: { threadId: 'x', turn: { id: s.turnId } } }) + '\n')
    const turn = { id: s.turnId, status: 'failed', error: { message: 'Try again later.', codexErrorInfo: 'usageLimitExceeded' } }
    s.fake.stdout(JSON.stringify({ method: 'turn/completed', params: { threadId: 'x', turn } }) + '\n')
    expect(types(s.events)).toEqual(['turn.started', 'limit.reached', 'turn.completed'])
  })

  it('interrupts the running turn, waiting for its id if Codex has not given it yet', async () => {
    const s = await replay('interrupted')
    s.feed(0, 2)
    s.session.interrupt()
    await s.pump()
    expect(s.sent('turn/interrupt')[0].params).toEqual({ threadId: expect.any(String), turnId: s.turnId })
    s.feed(2)
    expect(s.events.at(-1)).toEqual({ type: 'turn.completed', error: 'Interrupted', errorKind: 'interrupted' })

    const early = startSession()
    early.session.prompt('hi')
    early.session.interrupt()
    expect(early.sent('turn/interrupt')).toEqual([])
    await early.pump()
    expect(early.sent('turn/interrupt')[0].params.turnId).toBe('turn-1')
  })

  it('steers the running turn and lands the message where Codex takes it in', async () => {
    const s = await replay('steer')
    s.feed(0, s.lines.findIndex((l) => l.includes('commandExecution')) + 1)
    s.session.steer!('s1', 'Also check the tests')
    await s.pump()
    expect(s.sent('turn/steer')[0].params).toEqual({
      threadId: expect.any(String),
      expectedTurnId: s.turnId,
      clientUserMessageId: 's1',
      input: [{ type: 'text', text: 'Also check the tests', text_elements: [] }],
    })
    s.feed(s.lines.findIndex((l) => l.includes('commandExecution')) + 1)
    expect(s.events.filter((e) => e.type === 'steer.landed')).toEqual([{ type: 'steer.landed', id: 's1' }])
    // Where Codex took it in: before the reply it led to.
    expect(types(s.events).indexOf('steer.landed')).toBeLessThan(types(s.events).indexOf('text.delta'))
    // The steer cut the command's wait short and Codex never finishes it, so it shows stopped from the moment the steer
    // lands.
    const closed = s.events.find((e) => e.type === 'tool.completed')
    expect(closed).toMatchObject({ stopped: true, isError: false, output: expect.stringContaining('Cut short by your message') })
    expect(types(s.events).indexOf('tool.completed')).toBeLessThan(types(s.events).indexOf('steer.landed'))
    expect(types(s.events).at(-1)).toBe('turn.completed')
  })

  it("doesn't cut short a command still waiting on the user's approval when a steer lands", async () => {
    const s = await replay('steer')
    const approval = s.lines.findIndex((l) => l.includes('requestApproval'))
    s.feed(0, approval + 1)
    s.session.steer!('s1', 'Also check the tests')
    await s.pump()
    const landed = s.lines.findIndex((l) => l.includes('"clientId":"s1"'))
    // Without Codex's note that the request was resolved, the approval is still open.
    for (const line of s.lines.slice(approval + 1, landed + 1)) {
      if (!line.includes('serverRequest/resolved')) s.fake.stdout(line + '\n')
    }
    expect(s.events.some((e) => e.type === 'steer.landed')).toBe(true)
    expect(s.events.filter((e) => e.type === 'tool.completed' && e.stopped)).toEqual([])
  })

  it('hands back a steer Codex refuses, and one sent with no turn running', async () => {
    const s = startSession()
    s.session.steer!('idle', 'x')
    expect(s.events).toEqual([{ type: 'steer.returned', id: 'idle' }])
    await s.pump()
    s.session.prompt('hi')
    await s.pump()
    s.session.steer!('s2', 'y')
    await tick()
    const steer = s.sent('turn/steer')[0]
    s.fake.stdout(JSON.stringify({ id: steer.id, error: { code: -32600, message: 'not steerable' } }) + '\n')
    await tick()
    expect(s.events.at(-1)).toEqual({ type: 'steer.returned', id: 's2' })
  })

  it('stops a turn Codex starts on its own and ignores it', async () => {
    const s = startSession()
    await s.pump()
    s.fake.stdout(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'own' } } }) + '\n')
    await s.pump()
    expect(s.sent('turn/interrupt')[0].params).toEqual({ threadId: 'thread-1', turnId: 'own' })
    s.fake.stdout(JSON.stringify({ method: 'item/agentMessage/delta', params: { turnId: 'own', delta: 'x' } }) + '\n')
    s.fake.stdout(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'own', status: 'interrupted' } } }) + '\n')
    expect(s.events).toEqual([])
  })

  it("asks Codex's questions and answers them by question id", async () => {
    const s = startSession()
    await s.pump()
    s.session.prompt('hi')
    await s.pump()
    const questions = [{ id: 'color', header: 'Color', question: 'Which color?', isOther: true, isSecret: false, options: [{ label: 'Red', description: 'Warm' }] }]
    s.fake.stdout(JSON.stringify({ id: 7, method: 'item/tool/requestUserInput', params: { turnId: 'turn-1', itemId: 'i1', questions } }) + '\n')
    expect(s.events.at(-1)).toEqual({
      type: 'question.asked',
      requestId: 'codex-7',
      toolId: 'i1',
      questions: [{ header: 'Color', question: 'Which color?', options: [{ label: 'Red', description: 'Warm' }], multiSelect: false }],
    })
    s.session.answer!('codex-7', { 'Which color?': ['Red'] })
    expect(s.fake.sent().at(-1)).toEqual({ id: 7, result: { answers: { color: { answers: ['Red'] } } } })
  })

  it("refuses the server requests Kothar doesn't handle, so Codex never waits on them", async () => {
    const s = startSession()
    s.fake.stdout(JSON.stringify({ id: 9, method: 'account/chatgptAuthTokens/refresh', params: {} }) + '\n')
    expect(s.fake.sent().at(-1)).toMatchObject({ id: 9, error: { code: -32601 } })
  })

  it("ends the session on exit, with Codex's last error lines but not its warnings", async () => {
    const s = startSession()
    s.session.prompt('hi')
    s.fake.exit(1, 'WARNING: could not create PATH aliases\nError: config failed\n')
    await s.pump()
    expect(s.events).toEqual([{ type: 'turn.started' }, { type: 'session.ended', error: 'Error: config failed', errorKind: 'other' }])
    const closed = startSession()
    closed.session.close()
    expect(closed.fake.state).toEqual({ stdinClosed: true, killed: true })
    closed.fake.exit(null)
    expect(closed.events).toEqual([{ type: 'session.ended' }])
  })

  it('reads the command out of the shell Codex wraps it in', () => {
    expect(commandOf("/bin/zsh -lc 'ls -la'")).toBe('ls -la')
    expect(commandOf("/bin/bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'")
    expect(commandOf('git status')).toBe('git status')
    expect(commandOf("/bin/zsh -lc 'a' && rm x")).toBe("/bin/zsh -lc 'a' && rm x")
  })

  describe('detect', () => {
    it('is not installed when codex --version fails', async () => {
      expect(await codex.detect(fakeMachine().machine)).toEqual({ installed: false, signedIn: false })
    })

    it("lists the app-server's models with the levels each takes, and the default", async () => {
      const fake = fakeMachine({
        'codex --version': { code: 0, stdout: 'codex-cli 0.167.0\n', stderr: '' },
        'codex login status': { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' },
        // auth.json is there: the login is in a file sessions can link.
        '/bin/sh': { code: 0, stdout: '', stderr: '' },
      })
      const detecting = codex.detect(fake.machine)
      await tick()
      expect(fake.spawned[0]!.args.slice(2)).toEqual(['codex', 'app-server'])
      expect(fake.sent()[0]).toMatchObject({ id: 1, method: 'initialize' })
      fake.stdout(JSON.stringify({ id: 1, result: {} }) + '\n')
      const efforts = (...levels: string[]) => levels.map((reasoningEffort) => ({ reasoningEffort, description: '' }))
      const page1 = [
        { id: 'gpt-6.1-sol', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
        { id: 'secret', hidden: true, supportedReasoningEfforts: efforts('low') },
      ]
      fake.stdout(JSON.stringify({ id: 2, result: { data: page1, nextCursor: 'next' } }) + '\n')
      expect(fake.sent().at(-1)).toEqual({ id: 3, method: 'model/list', params: { cursor: 'next' } })
      const page2 = [{ id: 'gpt-5.5', supportedReasoningEfforts: efforts('none', 'low', 'medium', 'high', 'xhigh') }]
      fake.stdout(JSON.stringify({ id: 3, result: { data: page2, nextCursor: null } }) + '\n')
      expect(await detecting).toEqual({
        installed: true,
        signedIn: true,
        detail: 'codex-cli 0.167.0',
        models: ['gpt-6.1-sol', 'gpt-5.5'],
        thinking: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
        modelThinking: { 'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'], 'gpt-5.5': ['off', 'low', 'medium', 'high', 'xhigh'] },
        defaultModel: 'gpt-6.1-sol',
        defaultThinking: 'low',
      })
      expect(fake.state).toEqual({ stdinClosed: true, killed: true })
    })
  })

  describe('accounts', () => {
    it("checks an account's login with codex login status in its folder", async () => {
      const signedIn = fakeMachine({ 'codex login status': { code: 0, stdout: 'Logged in using ChatGPT (me@example.com)\n', stderr: '' } })
      expect(await codex.accounts!.status(signedIn.machine, '/acc')).toEqual({ signedIn: true, label: 'me@example.com' })
      expect(signedIn.ran[0]!.env).toEqual({ CODEX_HOME: '/acc' })
      const out = fakeMachine({ 'codex login status': { code: 1, stdout: '', stderr: 'Not logged in\n' } })
      expect(await codex.accounts!.status(out.machine, '/acc')).toEqual({ signedIn: false })
    })

    it("says so when the user's own Codex keeps its login in the Keychain, where sessions can't reach it", async () => {
      const status = { code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' }
      const keychain = fakeMachine({ 'codex login status': status, '/bin/sh': { code: 1, stdout: '', stderr: '' } })
      expect(await codex.accounts!.status(keychain.machine)).toEqual({ signedIn: false, note: KEYCHAIN_NOTE })
      expect(keychain.ran[1]!.args.at(-1)).toMatch(/\/auth\.json$/)
      const file = fakeMachine({ 'codex login status': status, '/bin/sh': { code: 0, stdout: '', stderr: '' } })
      expect(await codex.accounts!.status(file.machine)).toEqual({ signedIn: true })
      // An account added in Kothar always keeps its login in its own auth.json.
      const added = fakeMachine({ 'codex login status': status })
      expect(await codex.accounts!.status(added.machine, '/acc')).toEqual({ signedIn: true })
      expect(added.ran).toHaveLength(1)
    })

    it('says an API key set only in the environment signs no session in, rather than blaming the Keychain', async () => {
      const withEnv = (env: Record<string, string>) => createCodex({ env, home: '/Users/me' })
      // Codex's login status ignores the variable, so it reports no login.
      const out = { code: 1, stdout: '', stderr: 'Not logged in\n' }
      const envOnly = fakeMachine({ 'codex login status': out })
      const codexKey = withEnv({ OPENAI_API_KEY: '', CODEX_API_KEY: 'sk-test' })
      expect(await codexKey.accounts!.status(envOnly.machine)).toEqual({ signedIn: false, note: envKeyNote('CODEX_API_KEY') })
      expect(envOnly.ran).toHaveLength(1)
      const openai = withEnv({ CODEX_API_KEY: '', OPENAI_API_KEY: 'sk-test' })
      expect(await openai.accounts!.status(fakeMachine({ 'codex login status': out }).machine)).toEqual({
        signedIn: false,
        note: envKeyNote('OPENAI_API_KEY'),
      })
      // An account added in Kothar has its own login; the variable says nothing about it.
      expect(await openai.accounts!.status(fakeMachine({ 'codex login status': out }).machine, '/acc')).toEqual({ signedIn: false })
      // A real login wins: the Keychain check runs as before.
      const status = { code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' }
      const keychain = fakeMachine({ 'codex login status': status, '/bin/sh': { code: 1, stdout: '', stderr: '' } })
      expect(await openai.accounts!.status(keychain.machine)).toEqual({ signedIn: false, note: KEYCHAIN_NOTE })
    })

    it('signs in with the browser flow in the account folder, passing its link on', () => {
      const fake = fakeMachine()
      const login: any[] = []
      codex.accounts!.login(fake.machine, '/acc', (e) => login.push(e))
      expect(fake.spawned[0]).toMatchObject({ command: '/bin/sh', cwd: '/acc', env: { CODEX_HOME: '/acc' } })
      expect(fake.spawned[0]!.args[1]).toContain('codex login')
      fake.stdout('Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?client_id=x&state=y\n')
      fake.exit(0)
      // Codex opens the link itself and finishes on the redirect, so Kothar asks for no code.
      const url = 'https://auth.openai.com/oauth/authorize?client_id=x&state=y'
      expect(login).toEqual([{ type: 'url', url, noCode: true }, { type: 'done' }])
    })

    it('signs out with codex logout', async () => {
      const fake = fakeMachine({ 'codex logout': { code: 0, stdout: '', stderr: '' } })
      await codex.accounts!.logout(fake.machine, '/acc')
      expect(fake.ran[0]).toMatchObject({ command: 'codex', args: ['logout'], env: { CODEX_HOME: '/acc' } })
    })
  })

  describe('complete', () => {
    const request = { cwd: '/tmp', system: 'Summarize.', prompt: 'text', model: 'gpt-6-luna', timeoutMs: 1000 }

    it('runs codex exec with no tools and the system prompt as developer instructions, and returns its last message', async () => {
      const stdout = [
        { type: 'thread.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'The summary.' } },
        { type: 'turn.completed' },
      ].map((e) => JSON.stringify(e)).join('\n')
      const fake = fakeMachine({ '/bin/sh': { code: 0, stdout, stderr: '' } })
      expect(await codex.complete!(fake.machine, { ...request, schema: { type: 'object' } })).toBe('The summary.')
      const [ran] = fake.ran
      expect(ran!.args.slice(2, 4)).toEqual(['codex', 'exec'])
      expect(ran!.args).toEqual(expect.arrayContaining(['--json', '--ephemeral', '--model', 'gpt-6-luna']))
      expect(ran!.input).toBe('text')
      expect(ran!.env?.KOTHAR_CODEX_CONFIG).toContain('developer_instructions = "Summarize."')
      expect(ran!.env?.KOTHAR_CODEX_CONFIG).toContain('shell_tool = false')
      expect(ran!.env?.KOTHAR_CODEX_SCHEMA).toBe('{"type":"object"}')
    })

    it("throws Codex's failure", async () => {
      const stdout = JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } })
      const fake = fakeMachine({ '/bin/sh': { code: 1, stdout, stderr: '' } })
      await expect(codex.complete!(fake.machine, request)).rejects.toThrow('usage limit reached')
    })
  })

  describe('launcher', () => {
    let dir: string
    const path = process.env.PATH
    afterEach(() => {
      process.env.PATH = path
      rmSync(dir, { recursive: true, force: true })
    })

    // A stand-in codex that reports its CODEX_HOME and arguments as its reply.
    function fakeCodex() {
      dir = mkdtempSync(join(tmpdir(), 'kothar-codex-test-'))
      mkdirSync(join(dir, 'bin'))
      mkdirSync(join(dir, 'login'))
      writeFileSync(join(dir, 'login', 'auth.json'), '{"tokens":1}')
      const script = `#!/bin/sh
home=$CODEX_HOME
auth=$(cat "$home/auth.json"); link=$( [ -L "$home/auth.json" ] && echo link || echo file )
schema=$( [ -f "$home/schema.json" ] && cat "$home/schema.json" )
leak=\${KOTHAR_CODEX_AUTH:-}\${KOTHAR_CODEX_CONFIG:-}
node -e 'console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ home: process.argv[1], args: process.argv.slice(6), config: require("fs").readFileSync(process.argv[1] + "/config.toml", "utf8"), auth: process.argv[2], link: process.argv[3], schema: process.argv[4], leak: process.argv[5] }) } }))' "$home" "$auth" "$link" "$schema" "$leak" "$@"
`
      writeFileSync(join(dir, 'bin', 'codex'), script)
      chmodSync(join(dir, 'bin', 'codex'), 0o755)
      process.env.PATH = `${join(dir, 'bin')}:${path}`
    }

    const request = { cwd: '/tmp', system: 'S', prompt: 'p', model: 'm', timeoutMs: 20_000 }

    it("makes a fresh CODEX_HOME with Kothar's config and the account's login linked in, and removes it after", async () => {
      fakeCodex()
      const seen = JSON.parse(await codex.complete!(localMachine, { ...request, accountDir: join(dir, 'login'), schema: { type: 'object' } }))
      expect(seen.config).toContain('developer_instructions = "S"')
      expect(seen.auth).toBe('{"tokens":1}')
      expect(seen.link).toBe('link')
      expect(seen.schema).toBe('{"type":"object"}')
      expect(seen.args.slice(-2)).toEqual(['--output-schema', join(seen.home, 'schema.json')])
      expect(seen.leak).toBe('')
      expect(existsSync(seen.home)).toBe(false)
    })

    it("writes an API key account's own auth.json instead of a link", async () => {
      fakeCodex()
      const seen = JSON.parse(await codex.complete!(localMachine, { ...request, accountDir: join(dir, 'login'), apiKey: 'sk-x' }))
      expect(seen.link).toBe('file')
      expect(JSON.parse(seen.auth)).toEqual({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' })
      expect(seen.args).not.toContain('--output-schema')
    })
  })
})
