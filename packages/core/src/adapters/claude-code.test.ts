import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { EngineEvent } from '../types.ts'
import { claudeCode } from './claude-code.ts'
import { fakeMachine } from './test-machine.ts'

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}.jsonl`, import.meta.url), 'utf8')

function startSession(instructions = '') {
  const fake = fakeMachine()
  const events: EngineEvent[] = []
  const session = claudeCode.start(fake.machine, { cwd: '/tmp/project', instructions }, (e) => events.push(e))
  return { fake, events, session }
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
          '--settings', '{"autoMemoryEnabled":false}',
          '--thinking-display', 'summarized',
        ],
      },
    ])
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
      { type: 'permission.requested', requestId, toolId, name: 'Bash', kind: 'shell', summary: 'echo hi > a.txt', input },
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

  it('reports an error result and a nonzero exit with the stderr tail', () => {
    const { fake, events, session } = startSession()
    session.prompt('hi')
    fake.stdout(fixture('error-result'))
    fake.stderr('starting\n')
    fake.stderr('[claude-code:unrecognized_model] {"model":"claude-nonexistent-9"}\n')
    fake.exit(1)
    const message =
      "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access " +
      'to it. Run --model to pick a different model.'
    expect(events.slice(-3)).toEqual([
      { type: 'text.completed', text: message },
      { type: 'turn.completed', error: message },
      {
        type: 'session.ended',
        error: 'starting\n[claude-code:unrecognized_model] {"model":"claude-nonexistent-9"}',
      },
    ])
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
      ['WebSearch', { query: 'hotrod' }],
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
      'hotrod',
      '{"a":1,"b":"two words\\nmore"}',
      '{}',
    ])
  })

  it('summarizes a permission request', () => {
    const { fake, events } = startSession()
    const request = { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/c.ts', content: 'x' } }
    fake.stdout(JSON.stringify({ type: 'control_request', request_id: 'r1', request }) + '\n')
    expect(events).toEqual([
      { type: 'permission.requested', requestId: 'r1', name: 'Write', kind: 'edit', summary: '/c.ts', input: request.input },
    ])
  })

  it('closes stdin and kills the process', () => {
    const { fake, events, session } = startSession()
    session.close()
    expect(fake.state).toEqual({ stdinClosed: true, killed: true })
    fake.exit(null)
    expect(events).toEqual([{ type: 'session.ended' }])
  })

  it('does not kill a process that already exited', () => {
    const { fake, session } = startSession()
    fake.exit(0)
    session.close()
    expect(fake.state.killed).toBe(false)
  })
})

describe('claudeCode.detect', () => {
  it('reports installed and signed in', async () => {
    const { machine } = fakeMachine({
      'claude --version': { code: 0, stdout: '2.1.319 (Claude Code)\n', stderr: '' },
      'claude auth status': { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' },
    })
    expect(await claudeCode.detect(machine)).toEqual({ installed: true, signedIn: true, detail: '2.1.319 (Claude Code)' })
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
