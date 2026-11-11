import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localMachine } from '../machine.ts'
import { type EngineEvent, type SessionOptions } from '../shared.ts'
import { createPi, pi } from './pi.ts'
import { fakeMachine } from './test-machine.ts'

const fixture = (name: string) => readFileSync(new URL(`fixtures/pi/${name}.jsonl`, import.meta.url), 'utf8')

function startSession(instructions = '', extra: Partial<SessionOptions> = {}, adapter = pi) {
  const fake = fakeMachine()
  const events: EngineEvent[] = []
  const session = adapter.start(fake.machine, { cwd: '/tmp/project', instructions, ...extra }, (e) => events.push(e))
  return { fake, events, session }
}

const line = (record: unknown) => JSON.stringify(record) + '\n'
const toolStart = (toolName: string, args: unknown, toolCallId = 't1') =>
  line({ type: 'tool_execution_start', toolCallId, toolName, args })

describe('pi adapter', () => {
  it('passes the model and thinking level only when set', () => {
    const { fake } = startSession('', { model: 'anthropic/claude-haiku-5-5', thinking: 'low' })
    const args = fake.spawned[0]?.args ?? []
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'anthropic/claude-haiku-5-5',
    ])
    expect(args.slice(args.indexOf('--thinking'), args.indexOf('--thinking') + 2)).toEqual(['--thinking', 'low'])
    expect(startSession().fake.spawned[0]?.args).not.toContain('--model')
    expect(startSession().fake.spawned[0]?.args).not.toContain('--thinking')
  })

  it('spawns pi in rpc mode with the clean flags and only its built-in MCP support, in the project folder', () => {
    const { fake } = startSession()
    const [spawned] = fake.spawned
    expect(spawned).toMatchObject({ command: '/bin/sh', cwd: '/tmp/project' })
    expect(spawned?.args.slice(0, 1)).toEqual(['-c'])
    expect(spawned?.args.slice(2)).toEqual([
      'pi',
      '--mode', 'rpc',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-approve',
      '-e', 'builtin:mcp',
    ])
  })

  it('takes the Kothar MCP server and extension servers', () => {
    expect(pi.kotharMcp).toBe(true)
  })

  it("gives pi exactly Kothar's server and the extensions' servers, direct, with the token only in its env", () => {
    const token = 'secret-token'
    const kotharMcp = { url: 'http://127.0.0.1:4317/mcp', token }
    const mcpServers = [
      { name: 'browser', command: '/bin/node', args: ['cli.js', '--headless'], env: { TMPDIR: '/t' }, allowTools: true },
      { name: 'bare', command: 'tool' },
    ]
    const spawned = startSession('', { kotharMcp, mcpServers }).fake.spawned[0]!
    const config = JSON.parse(spawned.env?.KOTHAR_PI_MCP ?? '')
    const direct = { exposure: 'direct', timeout: expect.any(Number) }
    expect(config).toEqual({
      mcpServers: {
        kothar: { url: kotharMcp.url, headers: { Authorization: 'Bearer ${KOTHAR_MCP_TOKEN}' }, ...direct },
        browser: { command: '/bin/node', args: ['cli.js', '--headless'], env: { TMPDIR: '/t' }, ...direct },
        bare: { command: 'tool', args: [], env: {}, ...direct },
      },
    })
    expect(config.mcpServers.kothar.timeout).toBeGreaterThanOrEqual(60 * 60)
    expect(spawned.env?.KOTHAR_MCP_TOKEN).toBe(token)
    expect(spawned.args.join(' ')).not.toContain(token)
    expect(spawned.env?.KOTHAR_PI_MCP).not.toContain(token)
  })

  it('gives pi no MCP servers but the ones it is handed', () => {
    const spawned = startSession().fake.spawned[0]!
    expect(JSON.parse(spawned.env?.KOTHAR_PI_MCP ?? '')).toEqual({ mcpServers: {} })
    expect(spawned.env?.KOTHAR_MCP_TOKEN).toBeUndefined()
  })

  it('appends instructions to the system prompt when given', () => {
    const { fake } = startSession('Be brief.')
    expect(fake.spawned[0]?.args.slice(-2)).toEqual(['--append-system-prompt', 'Be brief.'])
  })

  it('lists the other folders in the instructions, since pi has no flag for them', () => {
    const withRules = startSession('Be brief.', { extraDirs: ['/tmp/a', '/tmp/b'] }).fake.spawned[0]!.args
    expect(withRules.at(-1)).toMatch(/^Be brief\.\n\n.*\n- \/tmp\/a\n- \/tmp\/b$/)
    const alone = startSession('', { extraDirs: ['/tmp/a'] }).fake.spawned[0]!.args
    expect(alone.at(-2)).toBe('--append-system-prompt')
    expect(alone.at(-1)).toMatch(/^[^\n]+\n- \/tmp\/a$/)
  })

  it('sends the prompt command and streams text', () => {
    const { fake, events, session } = startSession()
    session.prompt('Reply with exactly: Hello there')
    expect(fake.sent()).toEqual([{ type: 'prompt', message: 'Reply with exactly: Hello there' }])
    fake.stdout(fixture('text'))
    expect(events).toEqual([
      { type: 'turn.started' },
      { type: 'text.delta', text: 'Hello there' },
      { type: 'text.completed', text: 'Hello there' },
      { type: 'turn.completed' },
    ])
  })

  it('adds images to the prompt command, and says it takes image input', () => {
    const { fake, session } = startSession()
    session.prompt('What is this?', [{ mimeType: 'image/png', base64: 'aGk=' }])
    session.prompt('And this?', [])
    expect(fake.sent()).toEqual([
      { type: 'prompt', message: 'What is this?', images: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] },
      { type: 'prompt', message: 'And this?' },
    ])
    expect(pi.imageInput).toBe(true)
  })

  it('runs a tool without asking and reports its output', () => {
    const { fake, events, session } = startSession()
    session.prompt('Run ls with the bash tool, then reply with one word.')
    fake.stdout(fixture('tool'))
    const toolId = 'toolu_01AzEM9KHoqnRst3EYD92D7X'
    const input = { command: 'ls', timeout: null }
    expect(events).toEqual([
      { type: 'turn.started' },
      { type: 'tool.started', toolId, name: 'bash', kind: 'shell', summary: 'ls', input },
      { type: 'tool.completed', toolId, output: 'a.txt\nAGENTS.md\n', isError: false },
      { type: 'text.delta', text: 'Done' },
      { type: 'text.completed', text: 'Done' },
      { type: 'turn.completed' },
    ])
  })

  it('reports a failed turn with the provider error', () => {
    const { fake, events, session } = startSession()
    session.prompt('hi')
    fake.stdout(fixture('error'))
    expect(events).toEqual([
      { type: 'turn.started' },
      {
        type: 'turn.completed',
        error:
          '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},' +
          '"request_id":"req_011Cgnpak7k1PTbanzGJJQ4d"}',
      },
    ])
  })

  it('clears an error that a retry recovered from', () => {
    const { fake, events } = startSession()
    fake.stdout(line({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded' } }))
    fake.stdout(line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } }))
    fake.stdout(line({ type: 'agent_settled', aborted: false }))
    expect(events.at(-1)).toEqual({ type: 'turn.completed' })
  })

  it('reports a limit when the turn ends on a rate or usage limit error, not while pi retries', () => {
    const { fake, events } = startSession()
    const failed = (errorMessage: string) =>
      line({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage } })
    const limited = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}'
    fake.stdout(failed(limited))
    expect(events).toEqual([])
    fake.stdout(line({ type: 'agent_settled', aborted: false }))
    expect(events).toEqual([
      { type: 'limit.reached', message: limited },
      { type: 'turn.completed', error: limited },
    ])
    fake.stdout(failed('529 overloaded'))
    fake.stdout(line({ type: 'agent_settled', aborted: false }))
    expect(events.at(-2)?.type).toBe('turn.completed')
  })

  it('steers a message in with the steer command and reports it landed at the next user message', () => {
    const { fake, events, session } = startSession()
    session.prompt('Run ls')
    session.steer!('s1', 'Use -la', [{ mimeType: 'image/png', base64: 'aGk=' }])
    session.steer!('s2', 'Then stop')
    expect(fake.sent().slice(1)).toEqual([
      { type: 'set_steering_mode', mode: 'all' },
      { type: 'steer', id: 'steer-s1', message: 'Use -la', images: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] },
      { type: 'steer', id: 'steer-s2', message: 'Then stop' },
    ])
    const user = (text: string) => line({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } })
    fake.stdout(user('Run ls'))
    fake.stdout(line({ type: 'response', id: 'steer-s1', command: 'steer', success: true, data: { disposition: 'queued' } }))
    fake.stdout(line({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } }))
    fake.stdout(line({ type: 'tool_execution_end', toolCallId: 't1', result: { content: [{ type: 'text', text: 'a' }] } }))
    fake.stdout(user('Use -la'))
    fake.stdout(line({ type: 'agent_settled', aborted: false }))
    expect(events.map((e) => (e.type.startsWith('steer.') ? e : e.type))).toEqual([
      'turn.started',
      'tool.started',
      'tool.completed',
      { type: 'steer.landed', id: 's1' },
      { type: 'steer.returned', id: 's2' },
      'turn.completed',
    ])
    expect(pi.steering).toBe(true)
  })

  it('hands back a steer pi refuses, and clears waiting steers before an abort', () => {
    const { fake, events, session } = startSession()
    session.prompt('Go')
    session.steer!('s1', 'Nope')
    fake.stdout(line({ type: 'response', id: 'steer-s1', command: 'steer', success: false, error: 'not running' }))
    expect(events.at(-1)).toEqual({ type: 'steer.returned', id: 's1' })
    session.steer!('s2', 'Wait')
    session.interrupt()
    expect(fake.sent().slice(-2)).toEqual([{ type: 'clear_queue' }, { type: 'abort' }])
    fake.stdout(line({ type: 'agent_settled', aborted: true }))
    expect(events.slice(-2)).toEqual([
      { type: 'steer.returned', id: 's2' },
      { type: 'turn.completed', error: 'Interrupted' },
    ])
  })

  it('sends abort and reports the turn as interrupted, even mid tool call', () => {
    const { fake, events, session } = startSession()
    session.prompt('Run the bash command: sleep 30. Then reply with one word.')
    session.interrupt()
    expect(fake.sent()[1]).toEqual({ type: 'abort' })
    fake.stdout(fixture('interrupted-tool'))
    const toolId = 'toolu_0164i5GjwM9CtL41F3CbYXeU'
    expect(events).toEqual([
      { type: 'turn.started' },
      { type: 'tool.started', toolId, name: 'bash', kind: 'shell', summary: 'sleep 30', input: { command: 'sleep 30', timeout: 60 } },
      { type: 'tool.completed', toolId, output: 'Command aborted', isError: true },
      { type: 'turn.completed', error: 'Interrupted' },
    ])
  })

  it('keeps the partial text of an aborted reply', () => {
    const { fake, events } = startSession()
    fake.stdout(line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '1\n2' } }))
    fake.stdout(
      line({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '1\n2' }], stopReason: 'aborted', errorMessage: 'This operation was aborted' },
      }),
    )
    fake.stdout(line({ type: 'agent_settled', aborted: true }))
    expect(events).toEqual([
      { type: 'text.delta', text: '1\n2' },
      { type: 'text.completed', text: '1\n2' },
      { type: 'turn.completed', error: 'Interrupted' },
    ])
  })

  it('ends the turn when pi rejects the prompt', () => {
    const { fake, events } = startSession()
    fake.stdout(line({ type: 'response', command: 'prompt', success: false, error: 'Agent is busy' }))
    expect(events).toEqual([{ type: 'turn.completed', error: 'Agent is busy' }])
  })

  it('ends the turn when pi handles the prompt without a run', () => {
    const { fake, events } = startSession()
    fake.stdout(line({ type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } }))
    expect(events).toEqual([{ type: 'turn.completed' }])
  })

  it('streams thinking before the reply', () => {
    const { fake, events, session } = startSession()
    session.prompt('Is 91 prime? Think briefly, then answer in one short sentence.')
    fake.stdout(fixture('thinking'))
    const thinking = events.flatMap((e) => (e.type === 'thinking.delta' ? [e.text] : []))
    expect(thinking.join('')).toMatch(/^The user is asking if 91 is prime\..*don't need to use any tools\.$/s)
    expect(thinking.every(Boolean)).toBe(true)
    expect(events.map((e) => e.type).filter((type, i, all) => type !== all[i - 1])).toEqual([
      'turn.started',
      'thinking.delta',
      'text.delta',
      'text.completed',
      'turn.completed',
    ])
  })

  it('drops empty thinking, unknown records and other command responses', () => {
    const { fake, events } = startSession()
    fake.stdout(line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '' } }))
    fake.stdout(line({ type: 'queue_update', steering: [], followUp: [] }))
    fake.stdout(line({ type: 'response', command: 'abort', success: true }))
    fake.stdout('not json\n')
    expect(events).toEqual([])
  })

  it('joins a line split across chunks and accepts CRLF', () => {
    const { fake, events } = startSession()
    const text = fixture('text').replaceAll('\n', '\r\n')
    for (let i = 0; i < text.length; i += 7) fake.stdout(text.slice(i, i + 7))
    expect(events.map((e) => e.type)).toEqual(['text.delta', 'text.completed', 'turn.completed'])
  })

  it('keeps U+2028 and U+2029 inside a JSON string', () => {
    const { fake, events } = startSession()
    const text = 'one\u2028two\u2029three'
    const record = JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } })
    expect(record).toContain('\u2028')
    fake.stdout(record + '\n')
    expect(events).toEqual([{ type: 'text.delta', text }])
  })

  it('maps tool names to kinds', () => {
    const { fake, events } = startSession()
    const names = ['bash', 'powershell', 'edit', 'write', 'read', 'ls', 'grep', 'find', 'mcp__x__y', 'codemode']
    names.forEach((name, i) => fake.stdout(toolStart(name, {}, `t${i}`)))
    expect(events.map((e) => e.type === 'tool.started' && e.kind)).toEqual([
      'shell', 'shell', 'edit', 'edit', 'read', 'read', 'search', 'search', 'mcp', 'other',
    ])
  })

  it('summarizes tool inputs in one line', () => {
    const { fake, events } = startSession()
    const tools: [string, unknown][] = [
      ['bash', { command: 'ls\n  -la', timeout: null }],
      ['edit', { path: '/a.ts', edits: [] }],
      ['write', { path: '/b.ts', content: 'x' }],
      ['read', { path: '/c.ts', offset: 1 }],
      ['ls', { path: '/src' }],
      ['grep', { pattern: 'foo', path: '/src' }],
      ['find', { pattern: '*.ts' }],
      ['mcp__x__y', { a: 1, b: 'two  words\nmore' }],
      ['ls', {}],
    ]
    tools.forEach(([name, input], i) => fake.stdout(toolStart(name, input, `t${i}`)))
    expect(events.map((e) => e.type === 'tool.started' && e.summary)).toEqual([
      'ls -la',
      '/a.ts',
      '/b.ts',
      '/c.ts',
      '/src',
      'foo',
      '*.ts',
      '{"a":1,"b":"two words\\nmore"}',
      '{}',
    ])
  })

  it('never asks permission and ignores respond', () => {
    const { fake, session } = startSession()
    session.respond('r1', true)
    expect(fake.sent()).toEqual([])
  })

  it('ends the session cleanly on exit 0', () => {
    const { fake, events } = startSession()
    fake.exit(0)
    expect(events).toEqual([{ type: 'session.ended' }])
  })

  it('reports a startup failure with the stderr tail', () => {
    const { fake, events } = startSession()
    fake.exit(1, 'Error: Model "x" is ambiguous across providers\n')
    expect(events).toEqual([{ type: 'session.ended', error: 'Error: Model "x" is ambiguous across providers' }])
  })

  it('names the exit code when stderr is empty', () => {
    const { fake, events } = startSession()
    fake.exit(1)
    expect(events).toEqual([{ type: 'session.ended', error: 'pi exited with code 1' }])
  })

  it('closes stdin and kills the process', () => {
    const { fake, events, session } = startSession()
    session.close()
    expect(fake.state).toEqual({ stdinClosed: true, killed: true })
    fake.exit(null)
    expect(events).toEqual([{ type: 'session.ended' }])
  })

  it('kills on close even after the engine exited, to reach what it started', () => {
    const { fake, session } = startSession()
    fake.exit(0)
    session.close()
    expect(fake.state.killed).toBe(true)
  })
})

describe('pi.complete', () => {
  const request = { cwd: '/tmp/home', system: 'Summarize.', prompt: 'the items', schema: {}, model: 'anthropic/x', timeoutMs: 1234 }

  it('prints one clean reply with no tools and no thinking, prompt on stdin', async () => {
    const fake = fakeMachine({ pi: { code: 0, stdout: '{"summaries":[]}\n', stderr: '' } })
    expect(await pi.complete!(fake.machine, request)).toBe('{"summaries":[]}\n')
    expect(fake.ran).toEqual([
      {
        command: 'pi',
        args: [
          '-p',
          '--no-session',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-context-files',
          '--no-approve',
          '--no-mcp',
          '--no-tools',
          '--offline',
          '--model', 'anthropic/x',
          '--thinking', 'off',
          '--system-prompt', 'Summarize.',
        ],
        input: 'the items',
        timeoutMs: request.timeoutMs,
      },
    ])
  })

  it('fails with what pi said', async () => {
    const fake = fakeMachine({ pi: { code: 1, stdout: '', stderr: 'No API key for anthropic' } })
    await expect(pi.complete!(fake.machine, request)).rejects.toThrow('No API key for anthropic')
  })
})

describe('pi.detect', () => {
  const version = { code: 0, stdout: '1.5.0\n', stderr: '' }

  const rpc =
    'pi --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve ' +
    '--no-mcp --offline'
  const listed = [
    ['anthropic', 'claude-haiku-4-5'],
    ['anthropic', 'claude-haiku-4-5-20251001'],
    ['anthropic', 'claude-haiku-5-5'],
    ['anthropic', 'claude-opus-4-8'],
    ['openai', 'gpt-5'],
  ]
  const answers = (models: string[][], [provider, id]: string[], thinkingLevel: string) => ({
    code: 0,
    stdout:
      line({
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: models.map(([provider, id]) => ({ id, name: id, provider })) },
      }) +
      line({ type: 'response', command: 'get_state', success: true, data: { model: { id, provider }, thinkingLevel } }),
    stderr: '',
  })

  it('asks pi over RPC for its model ids, as listed, and the model and thinking level it starts on', async () => {
    const fake = fakeMachine({
      'pi --version': version,
      [rpc]: answers(listed, ['anthropic', 'claude-haiku-5-5'], 'xhigh'),
    })
    expect(await pi.detect(fake.machine)).toEqual({
      installed: true,
      signedIn: true,
      detail: '1.5.0',
      models: listed.map(([provider, id]) => `${provider}/${id}`),
      thinking: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultModel: 'anthropic/claude-haiku-5-5',
      defaultThinking: 'xhigh',
    })
    const input = fake.ran.find((r) => r.args.includes('rpc'))?.input ?? ''
    expect(input.split('\n').filter(Boolean).map((l) => JSON.parse(l).type)).toEqual([
      'get_available_models',
      'get_state',
    ])
  })

  it("reports each model's levels as pi works them out, and its minimal as low", async () => {
    const models = [
      { provider: 'a', id: 'plain', reasoning: false },
      { provider: 'a', id: 'reasons', reasoning: true },
      { provider: 'a', id: 'deep', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max', off: null } },
      { provider: 'a', id: 'unsaid' },
    ]
    const stdout =
      line({ type: 'response', command: 'get_available_models', success: true, data: { models } }) +
      line({ type: 'response', command: 'get_state', success: true, data: { model: models[1], thinkingLevel: 'minimal' } })
    const fake = fakeMachine({ 'pi --version': version, [rpc]: { code: 0, stdout, stderr: '' } })
    const detected = await pi.detect(fake.machine)
    expect(detected.modelThinking).toEqual({
      'a/plain': [],
      'a/reasons': ['off', 'low', 'medium', 'high'],
      'a/deep': ['low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(detected.defaultThinking).toBe('low')
  })

  it('maps each level onto its own --thinking value', () => {
    for (const level of ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const args = startSession('', { thinking: level }).fake.spawned[0]!.args
      expect(args[args.indexOf('--thinking') + 1]).toBe(level)
    }
  })

  it('leaves out a start model pi does not list', async () => {
    const fake = fakeMachine({ 'pi --version': version, [rpc]: answers(listed, ['anthropic', 'gone'], 'medium') })
    const detected = await pi.detect(fake.machine)
    expect(detected).toMatchObject({ defaultThinking: 'medium' })
    expect(detected.defaultModel).toBeUndefined()
  })

  it('reports signed out when pi has no models', async () => {
    const { machine } = fakeMachine({ 'pi --version': version, [rpc]: answers([], ['unknown', 'unknown'], 'off') })
    const detected = await pi.detect(machine)
    expect(detected).toMatchObject({ installed: true, signedIn: false, detail: '1.5.0', models: [] })
    expect(detected.defaultModel).toBeUndefined()
  })

  it('reports not installed', async () => {
    const { machine } = fakeMachine()
    expect(await pi.detect(machine)).toEqual({ installed: false, signedIn: false })
  })
})

describe("pi's own agent folder", () => {
  const saved = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }
  let root = ''
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('makes one per session from the mcp.json and links to the login, and removes it when pi exits', async () => {
    root = mkdtempSync(join(tmpdir(), 'kothar-pi-test-'))
    const bin = join(root, 'bin')
    const login = join(root, 'login')
    const project = join(root, 'project')
    for (const dir of [bin, login, project]) mkdirSync(dir)
    for (const file of ['auth.json', 'settings.json', 'mcp.json', 'AGENTS.md']) writeFileSync(join(login, file), '{}')
    writeFileSync(
      join(bin, 'pi'),
      '#!/bin/sh\nout=$PWD\ncd "$PI_CODING_AGENT_DIR" || exit 1\necho "$PWD" > "$out/dir"\nls -A > "$out/entries"\n' +
        'readlink auth.json models.json models-store.json > "$out/links"\ncp mcp.json "$out/mcp.json"\n' +
        'echo "$@" > "$out/args"\n',
    )
    chmodSync(join(bin, 'pi'), 0o755)
    process.env.PATH = `${bin}:${process.env.PATH}`
    process.env.PI_CODING_AGENT_DIR = login
    const kotharMcp = { url: 'http://127.0.0.1:4317/mcp', token: 't' }
    const ended = new Promise<EngineEvent>((resolve) =>
      pi.start(localMachine, { cwd: project, instructions: '', kotharMcp }, (e) => e.type === 'session.ended' && resolve(e)),
    )
    expect(await ended).toEqual({ type: 'session.ended' })
    const read = (name: string) => readFileSync(join(project, name), 'utf8')
    expect(read('entries').split('\n').filter(Boolean).sort()).toEqual([
      'auth.json',
      'mcp.json',
      'models-store.json',
      'models.json',
    ])
    expect(read('links').split('\n').filter(Boolean)).toEqual(
      ['auth.json', 'models.json', 'models-store.json'].map((file) => join(login, file)),
    )
    expect(Object.keys(JSON.parse(read('mcp.json')).mcpServers)).toEqual(['kothar'])
    expect(read('args').trim()).toMatch(/^--mode rpc .*-e builtin:mcp$/)
    expect(existsSync(read('dir').trim())).toBe(false)
    expect(readFileSync(join(login, 'mcp.json'), 'utf8')).toBe('{}')
  })
})

describe('pi in a sandbox', () => {
  const sandbox = { writable: ['/work/space'], tmpDir: '/work/space/.tmp' }
  // The user's own environment, without PI_CODING_AGENT_DIR.
  const adapter = createPi({ env: {}, home: '/Users/me' })
  const stateFiles = (dir: string) =>
    ['auth.json*', 'settings.json.lock*', 'models-store.json*', 'install/update.lock*'].map((file) => join(dir, file))

  it('also lets it write only its login and lock files, under PI_CODING_AGENT_DIR or ~/.pi/agent', () => {
    const { fake } = startSession('', { sandbox }, adapter)
    const agentDir = '/Users/me/.pi/agent'
    expect(fake.spawned[0]?.sandbox).toEqual({ writable: ['/work/space', ...stateFiles(agentDir)], tmpDir: sandbox.tmpDir })
    const withAgentDir = createPi({ env: { PI_CODING_AGENT_DIR: '/pi-state' }, home: '/Users/me' })
    expect(startSession('', { sandbox }, withAgentDir).fake.spawned[0]?.sandbox?.writable).toEqual([
      '/work/space',
      ...stateFiles('/pi-state'),
    ])
  })

  it('sandboxes a one-shot completion the same way', async () => {
    const fake = fakeMachine({ pi: { code: 0, stdout: 'ok', stderr: '' } })
    await adapter.complete!(fake.machine, { cwd: '/work/home', system: 's', prompt: 'p', model: 'm', timeoutMs: 1, sandbox })
    expect(fake.ran[0]?.sandbox?.writable).toEqual(['/work/space', ...stateFiles('/Users/me/.pi/agent')])
  })
})
