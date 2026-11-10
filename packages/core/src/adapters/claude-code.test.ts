import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type EngineEvent, type LoginEvent, type SessionOptions } from '../shared.ts'
import { claudeCode, MAX_IMAGE_BASE64_CHARS } from './claude-code.ts'
import { fakeMachine } from './test-machine.ts'

const fixture = (name: string) => readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')

function startSession(instructions = '', extra: Partial<SessionOptions> = {}) {
  const fake = fakeMachine()
  const events: EngineEvent[] = []
  const options = { cwd: '/tmp/project', instructions, ...extra }
  const session = claudeCode.start(fake.machine, options, (e) => events.push(e))
  return { fake, events, session }
}

const detected = {
  'claude --version': { code: 0, stdout: '2.1.319 (Claude Code)\n', stderr: '' },
  'claude auth status': { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' },
}

describe('claudeCode adapter', () => {
  it('spawns claude with the clean flags in the project folder', () => {
    const { fake } = startSession()
    expect(fake.spawned).toEqual([
      {
        command: 'claude',
        cwd: '/tmp/project',
        args: [
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
          '--settings', '{"autoMemoryEnabled":false,"attribution":false}',
          '--thinking-display', 'summarized',
          '--disallowedTools', 'Agent', 'Task',
          '--replay-user-messages',
        ],
      },
    ])
  })

  it("connects Kothar's MCP server with the token in the env, and runs its tools without asking", () => {
    const fake = fakeMachine()
    const token = 'kothar-token-5678'
    const kotharMcp = { url: 'http://127.0.0.1:4317/mcp', token }
    claudeCode.start(fake.machine, { cwd: '/tmp/project', instructions: '', kotharMcp }, () => {})
    const args = fake.spawned[0]!.args
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toEqual({
      mcpServers: {
        kothar: { type: 'http', url: kotharMcp.url, headers: { Authorization: 'Bearer ${KOTHAR_MCP_TOKEN}' } },
      },
    })
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__kothar__*')
    expect(args.join(' ')).not.toContain(token)
    expect(fake.spawned[0]?.env).toEqual({ KOTHAR_MCP_TOKEN: token })
  })

  it("connects each extension's MCP server next to Kothar's, running without asking the tools of those that allow it", () => {
    const kotharMcp = { url: 'http://127.0.0.1:4317/mcp', token: 't' }
    const mcpServers = [
      { name: 'browser', command: '/bin/node', args: ['cli.js', '--headless'], env: { A: '1' }, allowTools: true },
      { name: 'asks', command: 'asks-mcp' },
    ]
    const args = startSession('', { kotharMcp, mcpServers, readFiles: ['/tmp/a.png'] }).fake.spawned[0]!.args
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers).toEqual({
      kothar: { type: 'http', url: kotharMcp.url, headers: { Authorization: 'Bearer ${KOTHAR_MCP_TOKEN}' } },
      browser: { type: 'stdio', command: '/bin/node', args: ['cli.js', '--headless'], env: { A: '1' } },
      asks: { type: 'stdio', command: 'asks-mcp', args: [], env: {} },
    })
    expect(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 4)).toEqual([
      'mcp__kothar__*',
      'mcp__browser__*',
      'Read(//tmp/a.png)',
    ])
    const alone = startSession('', { mcpServers: mcpServers.slice(1) }).fake.spawned[0]!.args
    expect(Object.keys(JSON.parse(alone[alone.indexOf('--mcp-config') + 1]!).mcpServers)).toEqual(['asks'])
    expect(alone).not.toContain('--allowedTools')
  })

  it('passes the model and effort only when set', async () => {
    const { models = [], thinking = [] } = await claudeCode.detect(fakeMachine(detected).machine)
    const model = models.at(-1)!
    const { fake } = startSession('', { model, thinking: thinking[0] })
    const args = fake.spawned[0]?.args ?? []
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', model])
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', thinking[0]])
    expect(startSession().fake.spawned[0]?.args).not.toContain('--model')
    expect(startSession().fake.spawned[0]?.args).not.toContain('--effort')
  })

  it("never offers off, which Claude Code's --effort has no value for", async () => {
    const { thinking = [] } = await claudeCode.detect(fakeMachine(detected).machine)
    expect(thinking).not.toContain('off')
  })

  it('reports the effort levels each model takes where they differ from the full list', async () => {
    const { models = [], thinking = [], modelThinking = {} } = await claudeCode.detect(fakeMachine(detected).machine)
    expect(thinking).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(modelThinking['claude-haiku-4-5']).toEqual([])
    expect(modelThinking['claude-opus-4-6']).toEqual(['low', 'medium', 'high', 'max'])
    expect(modelThinking['claude-opus-5-5']).toBeUndefined()
    expect(Object.keys(modelThinking).every((id) => models.includes(id))).toBe(true)
  })

  it('gives Claude Code the other folders with --add-dir', () => {
    const args = startSession('', { extraDirs: ['/tmp/a', '/tmp/b'] }).fake.spawned[0]!.args
    expect(args.filter((_, i) => args[i - 1] === '--add-dir')).toEqual(['/tmp/a', '/tmp/b'])
    expect(startSession().fake.spawned[0]?.args).not.toContain('--add-dir')
  })

  it('lets Claude Code read the files it is given without asking, next to the Kothar tools', () => {
    const readFiles = ['/tmp/a b/shot [1], (2).png', '/tmp/doc.pdf']
    const rules = ['Read(//tmp/a b/shot \\[1\\], (2).png)', 'Read(//tmp/doc.pdf)']
    const allowed = (args: string[]) => args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 4)
    const args = startSession('Be brief.', { readFiles }).fake.spawned[0]!.args
    expect(allowed(args)).toEqual([...rules, '--append-system-prompt'])
    const kotharMcp = { url: 'http://127.0.0.1:4317/mcp', token: 't' }
    const both = startSession('', { readFiles, kotharMcp }).fake.spawned[0]!.args
    expect(allowed(both)).toEqual(['mcp__kothar__*', ...rules])
    expect(both.filter((arg) => arg === '--allowedTools')).toHaveLength(1)
    expect(startSession('', { readFiles: [] }).fake.spawned[0]?.args).not.toContain('--allowedTools')
  })

  it('appends instructions to the system prompt when given', () => {
    const { fake } = startSession('Be brief.')
    expect(fake.spawned[0]?.args.slice(-2)).toEqual(['--append-system-prompt', 'Be brief.'])
  })

  it('writes the prompt as a user message and streams text', () => {
    const { fake, events, session } = startSession()
    session.prompt('Reply with exactly: Hello there')
    expect(fake.sent()).toEqual([
      { type: 'user', message: { role: 'user', content: 'Reply with exactly: Hello there' } },
    ])
    fake.stdout(fixture('text'))
    expect(events).toEqual([
      { type: 'turn.started' },
      { type: 'text.delta', text: 'Hello there' },
      { type: 'text.completed', text: 'Hello there' },
      { type: 'turn.completed' },
    ])
  })

  it('sends images as base64 image blocks after the text, and says it takes image input', () => {
    const { fake, session } = startSession()
    session.prompt('What is this?', [{ mimeType: 'image/png', base64: 'aGk=' }])
    expect(fake.sent()).toEqual([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
          ],
        },
      },
    ])
    expect(claudeCode.imageInput).toBe(true)
  })

  it('leaves out images over the API limit, which the prompt already names by path', () => {
    const { fake, session } = startSession()
    const fits = 'a'.repeat(MAX_IMAGE_BASE64_CHARS)
    session.prompt('Look', [
      { mimeType: 'image/png', base64: fits },
      { mimeType: 'image/jpeg', base64: `${fits}a` },
    ])
    expect(fake.sent()).toEqual([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fits } },
          ],
        },
      },
    ])
  })

  it("streams thinking text but not a subagent's", () => {
    const { fake, events } = startSession()
    const thinking = (text: string, parent: string | null = null) =>
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } },
        parent_tool_use_id: parent,
      }) + '\n'
    fake.stdout(thinking('Let me ') + thinking('check.') + thinking('inner', 'toolu_1'))
    expect(events).toEqual([
      { type: 'thinking.delta', text: 'Let me ' },
      { type: 'thinking.delta', text: 'check.' },
    ])
  })

  it('streams the thinking summary Claude Code sends with summarized display', () => {
    const { fake, events, session } = startSession()
    session.prompt('Think briefly, then answer: is 391 prime? One word.')
    fake.stdout(fixture('thinking-summarized'))
    const thinking = events.flatMap((e) => (e.type === 'thinking.delta' ? [e.text] : [])).join('')
    expect(thinking).toBe("I'm checking the factorization: 17 times 23 does come to 391, so that holds.\n\n")
    expect(events.at(-2)).toEqual({ type: 'text.completed', text: 'No.' })
  })

  it('shows nothing for thinking that arrives as a signature only', () => {
    const { fake, events, session } = startSession()
    session.prompt('Think hard: is 91 prime? Answer in one short sentence.')
    fake.stdout(fixture('thinking-redacted'))
    expect(events.map((e) => e.type)).not.toContain('thinking.delta')
    expect(events.at(-2)).toEqual({ type: 'text.completed', text: "No, 91 isn't prime, because 91 = 7 × 13." })
  })

  it('asks permission for a tool call and passes the input back on allow', () => {
    const { fake, events, session } = startSession()
    session.prompt('Run the shell command: echo hi > a.txt. Then say done.')
    fake.stdout(fixture('tool-allowed'))
    const input = { command: 'echo hi > a.txt', description: 'Write "hi" into a.txt' }
    const toolId = 'toolu_011eNwvXLH1mQVZbDCmJvRyH'
    const requestId = 'de66ecb3-0e29-4144-ade3-d72a3112773f'
    expect(events).toEqual([
      { type: 'turn.started' },
      { type: 'tool.started', toolId, name: 'Bash', kind: 'shell', summary: 'echo hi > a.txt', input },
      {
        type: 'permission.requested',
        requestId,
        toolId,
        name: 'Bash',
        kind: 'shell',
        summary: 'echo hi > a.txt',
        command: input.command,
        input,
      },
      { type: 'tool.completed', toolId, output: '(Bash completed with no output)', isError: false },
      { type: 'text.delta', text: 'Done' },
      { type: 'text.delta', text: '.' },
      { type: 'text.completed', text: 'Done.' },
      { type: 'turn.completed' },
    ])
    session.respond(requestId, true)
    expect(fake.sent().at(-1)).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: input } },
    })
  })

  it('sends the exact deny response', () => {
    const { fake, events, session } = startSession()
    session.prompt('Run the shell command: echo hi > b.txt. Then say done.')
    fake.stdout(fixture('tool-denied'))
    const requestId = '90671749-5320-4008-a994-bd916c58b9ee'
    session.respond(requestId, false)
    expect(fake.sent().length).toBe(2)
    expect(JSON.stringify(fake.sent()[1])).toBe(
      `{"type":"control_response","response":{"subtype":"success","request_id":"${requestId}",` +
        `"response":{"behavior":"deny","message":"The user denied this tool call."}}}`,
    )
    expect(events).toContainEqual({
      type: 'tool.completed',
      toolId: 'toolu_01BVnYUbWcQQhcTNKFWDHfa8',
      output: 'The user denied this tool call.',
      isError: true,
    })
    expect(events.at(-1)).toEqual({ type: 'turn.completed' })
  })

  it('asks the user its questions instead of asking permission, and sends the answers back', () => {
    const { fake, events, session } = startSession()
    session.prompt('Ask me how to format the output and which sections to include.')
    fake.stdout(fixture('question'))
    const requestId = 'ba7cc265-dc80-434a-81c3-62b4c86dd2e1'
    const toolId = 'toolu_01BqhmLWj3AJEKttR9LsogLH'
    const format = 'How should I format the output?'
    const sections = 'Which sections should I include?'
    const questions = [
      {
        header: 'Format',
        question: format,
        options: [
          { label: 'Summary', description: 'A brief, condensed output' },
          { label: 'Detailed', description: 'A fuller, more thorough output' },
        ],
        multiSelect: false,
      },
      {
        header: 'Sections',
        question: sections,
        options: [
          { label: 'Introduction', description: 'Opening section that sets up the content' },
          { label: 'Body', description: 'Main content section' },
          { label: 'Conclusion', description: 'Closing section that wraps up the content' },
        ],
        multiSelect: true,
      },
    ]
    expect(events.map((e) => e.type)).not.toContain('permission.requested')
    expect(events).toContainEqual({ type: 'question.asked', requestId, toolId, questions })
    expect(events.at(-2)).toEqual({ type: 'text.completed', text: 'Format: Detailed\nSections: Introduction, Body' })

    session.answer!(requestId, { [format]: ['Detailed'], [sections]: ['Introduction', 'Body'] })
    const input = JSON.parse(fixture('question').split('\n').find((l) => l.includes('control_request'))!).request.input
    expect(fake.sent().at(-1)).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: 'allow',
          updatedInput: { questions: input.questions, answers: { [format]: 'Detailed', [sections]: 'Introduction, Body' } },
        },
      },
    })
    session.answer!(requestId, { [format]: ['Summary'] })
    expect(fake.sent()).toHaveLength(2)
  })

  it('tells Claude Code the user declined to answer when they skip', () => {
    const { fake, session } = startSession()
    fake.stdout(fixture('question'))
    session.answer!('ba7cc265-dc80-434a-81c3-62b4c86dd2e1')
    const response = fake.sent().at(-1).response.response
    expect(response).toEqual({ behavior: 'deny', message: expect.stringContaining('declined to answer') })
  })

  it('passes on only the fields every engine shares, sending typed text as it was typed', () => {
    const { fake, events, session } = startSession()
    const question = { question: 'Color?', header: 'Color', options: [{ label: 'Red', preview: '<b>' }] }
    const request = { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [question] } }
    fake.stdout(JSON.stringify({ type: 'control_request', request_id: 'q1', request }) + '\n')
    expect(events).toEqual([
      {
        type: 'question.asked',
        requestId: 'q1',
        questions: [{ header: 'Color', question: 'Color?', options: [{ label: 'Red', description: '' }], multiSelect: false }],
      },
    ])
    session.answer!('q1', { 'Color?': ['Purple with green stripes'] })
    expect(fake.sent().at(-1).response.response.updatedInput.answers).toEqual({ 'Color?': 'Purple with green stripes' })
  })

  it('reports an API error once, as the error and not as reply text, and a nonzero exit with the stderr tail', () => {
    const { fake, events, session } = startSession()
    session.prompt('hi')
    fake.stdout(fixture('error-result'))
    fake.exit(1, 'starting\n[claude-code:unrecognized_model] {"model":"claude-nonexistent-9"}\n')
    const message =
      "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access " +
      'to it. Run --model to pick a different model.'
    expect(events).toEqual([
      { type: 'turn.started' },
      { type: 'turn.completed', error: message },
      {
        type: 'session.ended',
        error: 'starting\n[claude-code:unrecognized_model] {"model":"claude-nonexistent-9"}',
      },
    ])
  })

  describe('usage limits', () => {
    const rateLimit = (info: Record<string, unknown>) =>
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }) + '\n'
    const result = (text: string) =>
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: text }) + '\n'

    it('reports a rejected rate limit once a turn, named and with its reset, and ignores the rest', () => {
      const { fake, events, session } = startSession()
      session.prompt('hi')
      fake.stdout(rateLimit({ status: 'allowed_warning', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' }))
      fake.stdout(rateLimit({ status: 'rejected', rateLimitType: 'seven_day', isUsingOverage: true }))
      fake.stdout(rateLimit({ status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' }))
      fake.stdout(result("You've hit your 5-hour limit · resets 3pm"))
      const limit = {
        type: 'limit.reached',
        message: "The account's 5-hour usage limit is reached",
        resetsAt: '2030-03-17T17:46:40.000Z',
      }
      const ended = { type: 'turn.completed', error: "You've hit your 5-hour limit · resets 3pm" }
      expect(events.slice(1)).toEqual([limit, ended])

      session.prompt('again')
      fake.stdout(rateLimit({ status: 'rejected' }))
      expect(events.at(-1)).toEqual({ type: 'limit.reached', message: "The account's usage limit is reached" })
    })

    it('reads a limit from the error result alone, with the reset older versions add after a bar', () => {
      const { fake, events, session } = startSession()
      session.prompt('hi')
      fake.stdout(result('Claude AI usage limit reached|1900000000'))
      expect(events.slice(1, 2)).toEqual([
        { type: 'limit.reached', message: 'Claude AI usage limit reached', resetsAt: '2030-03-17T17:46:40.000Z' },
      ])
      session.prompt('hi')
      fake.stdout(result('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'))
      expect(events.at(-2)).toMatchObject({ type: 'limit.reached' })
      session.prompt('hi')
      fake.stdout(result('Something else broke'))
      expect(events.at(-2)).toEqual({ type: 'turn.started' })
    })
  })

  it('ends the session cleanly on exit 0', () => {
    const { fake, events } = startSession()
    fake.exit(0)
    expect(events).toEqual([{ type: 'session.ended' }])
  })

  it('names the exit code when stderr is empty', () => {
    const { fake, events } = startSession()
    fake.exit(1)
    expect(events).toEqual([{ type: 'session.ended', error: 'Claude Code exited with code 1' }])
  })

  it('sends an interrupt and reports the turn as interrupted', () => {
    const { fake, events, session } = startSession()
    session.prompt('Count from 1 to 200, one number per line.')
    session.interrupt()
    expect(fake.sent()[1]).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } })
    fake.stdout(fixture('interrupted'))
    expect(events.at(-1)).toEqual({ type: 'turn.completed', error: 'Interrupted' })
  })

  it('writes a steered message with a uuid and reports where the turn took it in', () => {
    const { fake, events, session } = startSession()
    session.prompt('Fix it')
    session.steer!('s1', 'Use y instead', [{ mimeType: 'image/png', base64: 'aGk=' }])
    session.steer!('s2', 'And z')
    const [, first, second] = fake.sent()
    expect(first).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Use y instead' }, { type: 'image' }] },
    })
    expect(first.uuid).toMatch(/^[0-9a-f-]{36}$/)
    const line = (msg: object) => fake.stdout(JSON.stringify(msg) + '\n')
    line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } })
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }] } })
    line({ type: 'command_lifecycle', command_uuid: first.uuid, state: 'queued' })
    line({ type: 'command_lifecycle', command_uuid: first.uuid, state: 'started' })
    // The replay of a message already landed, and of one Kothar never steered, change nothing.
    line({ type: 'user', isReplay: true, uuid: first.uuid, message: { role: 'user', content: 'Use y instead' } })
    line({ type: 'user', isReplay: true, uuid: 'not-ours', message: { role: 'user', content: 'Fix it' } })
    line({ type: 'user', isReplay: true, uuid: second.uuid, message: { role: 'user', content: 'And z' } })
    expect(events.slice(1)).toEqual([
      expect.objectContaining({ type: 'tool.started', toolId: 't1' }),
      { type: 'tool.completed', toolId: 't1', output: 'a', isError: false },
      { type: 'steer.landed', id: 's1' },
      { type: 'steer.landed', id: 's2' },
    ])
  })

  it("hands back a steer the turn didn't take in, withdrawing it so Claude Code starts no turn for it", () => {
    const { fake, events, session } = startSession()
    session.prompt('Say hi')
    session.steer!('s1', 'Also bye')
    const uuid = fake.sent()[1].uuid
    fake.stdout(fixture('text'))
    expect(events.slice(-2)).toEqual([{ type: 'steer.returned', id: 's1' }, { type: 'turn.completed' }])
    expect(fake.sent().at(-1)).toMatchObject({
      type: 'control_request',
      request: { subtype: 'cancel_async_message', message_uuid: uuid },
    })
  })

  it('says its sessions can steer', () => {
    expect(claudeCode.steering).toBe(true)
    expect(startSession().session.steer).toBeTypeOf('function')
  })

  it('joins a line split across chunks', () => {
    const { fake, events } = startSession()
    const text = fixture('text')
    for (let i = 0; i < text.length; i += 7) fake.stdout(text.slice(i, i + 7))
    expect(events.map((e) => e.type)).toEqual(['text.delta', 'text.completed', 'turn.completed'])
  })

  it('keeps U+2028 and U+2029 inside a JSON string', () => {
    const { fake, events } = startSession()
    const text = 'one\u2028two\u2029three'
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      parent_tool_use_id: null,
    })
    expect(line).toContain('\u2028')
    fake.stdout(line + '\n')
    expect(events).toEqual([{ type: 'text.delta', text }])
  })

  it('maps tool names to kinds', () => {
    const { fake, events } = startSession()
    const names = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'mcp__x__y', 'Task']
    const content = names.map((name, i) => ({ type: 'tool_use', id: `t${i}`, name, input: {} }))
    fake.stdout(JSON.stringify({ type: 'assistant', message: { content }, parent_tool_use_id: null }) + '\n')
    expect(events.map((e) => e.type === 'tool.started' && e.kind)).toEqual([
      'shell', 'edit', 'edit', 'edit', 'read', 'search', 'search', 'fetch', 'fetch', 'mcp', 'other',
    ])
  })

  it('summarizes tool inputs in one line', () => {
    const { fake, events } = startSession()
    const tools: [string, unknown][] = [
      ['Bash', { command: 'ls\n  -la', description: 'List' }],
      ['Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }],
      ['NotebookEdit', { notebook_path: '/n.ipynb' }],
      ['Read', { file_path: '/b.ts' }],
      ['Grep', { pattern: 'foo', path: '/src' }],
      ['WebFetch', { url: 'https://x.dev', prompt: 'p' }],
      ['WebSearch', { query: 'kothar' }],
      ['mcp__x__y', { a: 1, b: 'two  words\nmore' }],
      ['Bash', {}],
    ]
    const content = tools.map(([name, input], i) => ({ type: 'tool_use', id: `t${i}`, name, input }))
    fake.stdout(JSON.stringify({ type: 'assistant', message: { content }, parent_tool_use_id: null }) + '\n')
    expect(events.map((e) => e.type === 'tool.started' && e.summary)).toEqual([
      'ls -la',
      '/a.ts',
      '/n.ipynb',
      '/b.ts',
      'foo',
      'https://x.dev',
      'kothar',
      '{"a":1,"b":"two words\\nmore"}',
      '{}',
    ])
  })

  it('summarizes a permission request, with the path an edit writes and the command a shell runs', () => {
    const { fake, events } = startSession()
    const request = { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/c.ts', content: 'x' } }
    const notebook = { subtype: 'can_use_tool', tool_name: 'NotebookEdit', input: { notebook_path: '/n.ipynb' } }
    const shell = { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls /c.ts' } }
    for (const [id, req] of [['r1', request], ['r2', notebook], ['r3', shell]] as const) {
      fake.stdout(JSON.stringify({ type: 'control_request', request_id: id, request: req }) + '\n')
    }
    expect(events).toEqual([
      { type: 'permission.requested', requestId: 'r1', name: 'Write', kind: 'edit', summary: '/c.ts', path: '/c.ts', input: request.input },
      {
        type: 'permission.requested',
        requestId: 'r2',
        name: 'NotebookEdit',
        kind: 'edit',
        summary: '/n.ipynb',
        path: '/n.ipynb',
        input: notebook.input,
      },
      {
        type: 'permission.requested',
        requestId: 'r3',
        name: 'Bash',
        kind: 'shell',
        summary: 'ls /c.ts',
        command: 'ls /c.ts',
        input: shell.input,
      },
    ])
  })

  it('gives a read its file and a search its folder joined with its file filter', () => {
    const { fake, events } = startSession()
    const requests = [
      { tool_name: 'Read', input: { file_path: '/a/b.ts' } },
      { tool_name: 'Grep', input: { pattern: 'x', path: '/a', glob: '.env*' } },
      { tool_name: 'Grep', input: { pattern: 'x' } },
      { tool_name: 'Glob', input: { pattern: '**/*.ts', path: '/a' } },
    ]
    for (const [i, request] of requests.entries()) {
      const message = { type: 'control_request', request_id: `r${i}`, request: { subtype: 'can_use_tool', ...request } }
      fake.stdout(JSON.stringify(message) + '\n')
    }
    expect(events.map((e) => (e.type === 'permission.requested' ? [e.kind, e.path] : []))).toEqual([
      ['read', '/a/b.ts'],
      ['search', '/a/.env*'],
      ['search', undefined],
      ['search', '/a'],
    ])
  })

  it("tells Claude Code why a call was denied when given a reason", () => {
    const { fake, session } = startSession()
    const request = { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/c.ts', content: 'x' } }
    fake.stdout(JSON.stringify({ type: 'control_request', request_id: 'r1', request }) + '\n')
    session.respond('r1', false, 'Edit only inside /work.')
    expect(fake.sent().at(-1)).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: 'Edit only inside /work.' } },
    })
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

describe('claudeCode.complete', () => {
  const request = {
    cwd: '/tmp/home',
    system: 'Summarize.',
    prompt: 'the items',
    schema: { type: 'object' },
    model: 'claude-haiku-5-5',
    timeoutMs: 1234,
  }
  const reply = (fields: Record<string, unknown>, code = 0) => ({
    claude: { code, stdout: JSON.stringify({ type: 'result', is_error: false, result: '', ...fields }), stderr: '' },
  })

  it('runs one clean prompt with no tools, the system prompt and the schema, prompt on stdin', async () => {
    const fake = fakeMachine(reply({ structured_output: { summaries: [] } }))
    expect(await claudeCode.complete!(fake.machine, request)).toBe('{"summaries":[]}')
    expect(fake.ran).toEqual([
      {
        command: 'claude',
        args: [
          '-p',
          '--no-session-persistence',
          '--setting-sources', '',
          '--strict-mcp-config',
          '--disable-slash-commands',
          '--settings', '{"autoMemoryEnabled":false,"attribution":false}',
          '--tools', '',
          '--output-format', 'json',
          '--model', 'claude-haiku-5-5',
          '--system-prompt', 'Summarize.',
          '--json-schema', '{"type":"object"}',
        ],
        input: 'the items',
        timeoutMs: request.timeoutMs,
      },
    ])
  })

  it('returns the text without a schema, and uses the account', async () => {
    const fake = fakeMachine(reply({ result: 'plain text' }))
    const { schema, ...plain } = request
    expect(await claudeCode.complete!(fake.machine, { ...plain, accountDir: '/acct', apiKey: 'k' })).toBe('plain text')
    expect(fake.ran[0]?.args).not.toContain('--json-schema')
    expect(fake.ran[0]?.env).toEqual({ CLAUDE_CONFIG_DIR: '/acct', ANTHROPIC_API_KEY: 'k' })
  })

  it('fails with what Claude Code said, such as a usage limit', async () => {
    const limited = reply({ is_error: true, result: "You've hit your 5-hour limit" }, 1)
    await expect(claudeCode.complete!(fakeMachine(limited).machine, request)).rejects.toThrow('5-hour limit')
    const crashed = { claude: { code: 1, stdout: '', stderr: 'boom' } }
    await expect(claudeCode.complete!(fakeMachine(crashed).machine, request)).rejects.toThrow('boom')
  })
})

describe('claudeCode.detect', () => {
  it('reports installed and signed in, with the effort levels from claude --help', async () => {
    const status = await claudeCode.detect(fakeMachine(detected).machine)
    expect(status).toMatchObject({
      installed: true,
      signedIn: true,
      detail: '2.1.319 (Claude Code)',
      thinking: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(status).not.toHaveProperty('cheapModel')
  })

  it('offers the full model ids Claude Code accepts, previous versions included', async () => {
    const { models = [] } = await claudeCode.detect(fakeMachine(detected).machine)
    expect(models).toEqual(expect.arrayContaining(['claude-opus-5-5', 'claude-opus-4-8', 'claude-haiku-4-5']))
    expect(models.every((id) => typeof id === 'string' && id.startsWith('claude-'))).toBe(true)
  })

  it('names the model and effort Claude Code starts on with no flags, both of them offered', async () => {
    const { models = [], thinking = [], defaultModel, defaultThinking } = await claudeCode.detect(
      fakeMachine(detected).machine,
    )
    expect(models).toContain(defaultModel)
    expect(thinking).toContain(defaultThinking)
  })

  it('reports signed out', async () => {
    const { machine } = fakeMachine({
      'claude --version': { code: 0, stdout: '2.1.319 (Claude Code)\n', stderr: '' },
      'claude auth status': { code: 1, stdout: '{"loggedIn":false}', stderr: '' },
    })
    expect(await claudeCode.detect(machine)).toMatchObject({ installed: true, signedIn: false })
  })

  it('reports not installed', async () => {
    const { machine } = fakeMachine()
    expect(await claudeCode.detect(machine)).toEqual({ installed: false, signedIn: false })
  })
})

describe('claudeCode accounts', () => {
  const dir = '/garage/accounts/claude-code/work'
  const url = 'https://claude.com/cai/oauth/authorize?code=true&state=abc'
  const loginOutput = `Opening browser to sign in…\nIf the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\nPaste code here if prompted > `

  function startLogin() {
    const fake = fakeMachine()
    const events: LoginEvent[] = []
    const flow = claudeCode.accounts!.login(fake.machine, dir, (e) => events.push(e))
    return { fake, events, flow }
  }

  it('starts sessions in the account config folder', () => {
    const fake = fakeMachine()
    claudeCode.start(fake.machine, { cwd: '/tmp/project', instructions: '', accountDir: dir }, () => {})
    expect(fake.spawned[0]?.env).toEqual({ CLAUDE_CONFIG_DIR: dir })
  })

  it("passes an API-key account's key in the spawn env, never in the arguments", () => {
    const fake = fakeMachine()
    const apiKey = 'sk-ant-test-1234abcd'
    claudeCode.start(fake.machine, { cwd: '/tmp/project', instructions: '', accountDir: dir, apiKey }, () => {})
    expect(claudeCode.accounts?.apiKeys).toBe(true)
    expect(fake.spawned[0]?.env).toEqual({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: apiKey })
    expect(fake.spawned[0]?.args.join(' ')).not.toContain(apiKey)
  })

  it('reads the account status and email from its config folder', async () => {
    const fake = fakeMachine({
      'claude auth status': { code: 0, stdout: '{"loggedIn":true,"email":"me@work.test"}', stderr: '' },
    })
    expect(await claudeCode.accounts!.status(fake.machine, dir)).toEqual({ signedIn: true, label: 'me@work.test' })
    expect(fake.ran).toEqual([{ command: 'claude', args: ['auth', 'status'], env: { CLAUDE_CONFIG_DIR: dir } }])
  })

  it('logs in with the account config folder, passes on the sign-in link and a pasted code', () => {
    const { fake, events } = startLogin()
    expect(fake.spawned).toEqual([
      { command: 'claude', args: ['auth', 'login', '--claudeai'], cwd: dir, env: { CLAUDE_CONFIG_DIR: dir } },
    ])
    fake.stdout(loginOutput.slice(0, 90))
    expect(events).toEqual([])
    fake.stdout(loginOutput.slice(90))
    expect(events).toEqual([{ type: 'url', url }])
    fake.exit(0)
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('writes the pasted code to the login prompt', () => {
    const { fake, flow } = startLogin()
    flow.submitCode(' the-code#state \n')
    expect(fake.written()).toBe('the-code#state\n')
  })

  it('reports why a login failed', () => {
    const { fake, events } = startLogin()
    fake.stdout(loginOutput + "Login failed: That code wasn't accepted. Sign in again to get a new code.\n")
    fake.exit(1)
    expect(events.at(-1)).toEqual({
      type: 'failed',
      error: "Login failed: That code wasn't accepted. Sign in again to get a new code.",
    })
  })

  it('stops the login when cancelled', () => {
    const { fake, flow } = startLogin()
    flow.cancel()
    expect(fake.state.killed).toBe(true)
  })

  it('logs out of the account config folder only', async () => {
    const fake = fakeMachine({ 'claude auth logout': { code: 0, stdout: '', stderr: '' } })
    await claudeCode.accounts!.logout(fake.machine, dir)
    expect(fake.ran).toEqual([{ command: 'claude', args: ['auth', 'logout'], env: { CLAUDE_CONFIG_DIR: dir } }])
  })
})

describe('claudeCode in a sandbox', () => {
  const sandbox = { writable: ['/work/space'], tmpDir: '/work/space/.tmp' }
  const keychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db*')
  const defaultDir = join(homedir(), '.claude')
  const locks = [join(defaultDir, '.oauth_refresh.lock*'), join(defaultDir, '.storage-write.lock')]
  const defaultWritable = ['/work/space', join(defaultDir, 'shell-snapshots'), ...locks, keychain]
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  })

  it('also lets it write its shell snapshots, login locks and the keychain, with its temp folder in the sandbox', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    const { fake } = startSession('', { sandbox })
    expect(fake.spawned[0]?.sandbox).toEqual({ writable: defaultWritable, tmpDir: sandbox.tmpDir })
    expect(fake.spawned[0]?.env).toEqual({ CLAUDE_CODE_TMPDIR: sandbox.tmpDir })
  })

  it('lets it take the locks a login refresh needs, and keeps what can run code read-only', () => {
    const accountDir = '/garage/accounts/claude-code/work'
    const writable = startSession('', { sandbox, accountDir }).fake.spawned[0]?.sandbox?.writable ?? []
    const canWrite = (path: string) =>
      writable.some((w) => (w.endsWith('*') ? path.startsWith(w.slice(0, -1)) : path === w || path.startsWith(`${w}/`)))
    const refreshLocks = ['.oauth_refresh.lock', '.oauth_refresh.lock.owner', '.oauth_refresh.lock.owner.tmp.0a1b2c3d']
    for (const lock of [...refreshLocks, '.storage-write.lock']) expect(canWrite(join(accountDir, lock))).toBe(true)
    const codeRunning = ['settings.json', 'settings.local.json', 'CLAUDE.md', '.claude.json', 'hooks/a.sh', 'agents/a.md',
      'commands/a.md', 'output-styles/a.md', 'plugins/installed_plugins.json', 'skills/a/SKILL.md']
    for (const path of ['', ...codeRunning]) expect(canWrite(join(accountDir, path))).toBe(false)
  })

  it("puts the shell snapshots in the config folder it runs with: the account's, else CLAUDE_CONFIG_DIR", () => {
    process.env.CLAUDE_CONFIG_DIR = '/cfg'
    expect(startSession('', { sandbox }).fake.spawned[0]?.sandbox?.writable).toContain('/cfg/shell-snapshots')
    const accountDir = '/garage/accounts/claude-code/work'
    const inAccount = startSession('', { sandbox, accountDir }).fake.spawned[0]
    expect(inAccount?.sandbox?.writable).toContain(`${accountDir}/shell-snapshots`)
    expect(inAccount?.env).toEqual({ CLAUDE_CONFIG_DIR: accountDir, CLAUDE_CODE_TMPDIR: sandbox.tmpDir })
  })

  it('sandboxes a one-shot completion the same way', async () => {
    delete process.env.CLAUDE_CONFIG_DIR
    const stdout = JSON.stringify({ type: 'result', is_error: false, result: 'ok' })
    const fake = fakeMachine({ claude: { code: 0, stdout, stderr: '' } })
    const request = { cwd: '/work/home', system: 's', prompt: 'p', model: 'm', timeoutMs: 1, sandbox }
    await claudeCode.complete!(fake.machine, request)
    expect(fake.ran[0]?.sandbox?.writable).toEqual(defaultWritable)
    expect(fake.ran[0]?.env).toEqual({ CLAUDE_CODE_TMPDIR: sandbox.tmpDir })
  })
})
