import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { EngineEvent } from '../types.ts'
import { pi } from './pi.ts'
import { fakeMachine } from './test-machine.ts'

const fixture = (name: string) => readFileSync(new URL(`fixtures/pi-${name}.jsonl`, import.meta.url), 'utf8')

function startSession(instructions = '') {
  const fake = fakeMachine()
  const events: EngineEvent[] = []
  const session = pi.start(fake.machine, { cwd: '/tmp/project', instructions }, (e) => events.push(e))
  return { fake, events, session }
}

const line = (record: unknown) => JSON.stringify(record) + '\n'
const toolStart = (toolName: string, args: unknown, toolCallId = 't1') =>
  line({ type: 'tool_execution_start', toolCallId, toolName, args })

describe('pi adapter', () => {
  it('spawns pi in rpc mode with the clean flags in the project folder', () => {
    const { fake } = startSession()
    expect(fake.spawned).toEqual([
      {
        command: 'pi',
        cwd: '/tmp/project',
        args: [
          '--mode', 'rpc',
          '--no-session',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-mcp',
          '--no-context-files',
          '--no-approve',
        ],
      },
    ])
  })

  it('appends instructions to the system prompt when given', () => {
    const { fake } = startSession('Be brief.')
    expect(fake.spawned[0]?.args.slice(-2)).toEqual(['--append-system-prompt', 'Be brief.'])
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

  it('drops thinking, unknown records and other command responses', () => {
    const { fake, events } = startSession()
    fake.stdout(line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' } }))
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
    fake.stderr('Error: Model "x" is ambiguous across providers\n')
    fake.exit(1)
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

  it('does not kill a process that already exited', () => {
    const { fake, session } = startSession()
    fake.exit(0)
    session.close()
    expect(fake.state.killed).toBe(false)
  })
})

describe('pi.detect', () => {
  const version = { code: 0, stdout: '1.5.0\n', stderr: '' }

  it('reports installed and signed in when pi lists a model', async () => {
    const { machine } = fakeMachine({
      'pi --version': version,
      'pi --list-models --offline': {
        code: 0,
        stdout: 'provider   model             context  max-out  thinking  images\nanthropic  claude-haiku-5-5  1M  128K  yes  yes\n',
        stderr: '',
      },
    })
    expect(await pi.detect(machine)).toEqual({ installed: true, signedIn: true, detail: '1.5.0' })
  })

  it('reports signed out when pi has no models', async () => {
    const { machine } = fakeMachine({
      'pi --version': version,
      'pi --list-models --offline': {
        code: 0,
        stdout: 'No models available. Use /login to log into a provider via OAuth or API key. See:\n',
        stderr: '',
      },
    })
    expect(await pi.detect(machine)).toEqual({ installed: true, signedIn: false, detail: '1.5.0' })
  })

  it('reports not installed', async () => {
    const { machine } = fakeMachine()
    expect(await pi.detect(machine)).toEqual({ installed: false, signedIn: false })
  })
})
