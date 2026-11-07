import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, type FakeStep } from './adapters/fake.ts'
import { openCore, type Core } from './core.ts'
import { localMachine } from './machine.ts'
import type { Adapter, ChatEntry, CoreMessage, EngineEvent, SessionOptions } from './types.ts'

const TEST_INTERRUPT_GRACE_MS = 30

const textScript: FakeStep[] = [
  { type: 'text.delta', text: 'Hel' },
  { type: 'text.delta', text: 'lo' },
  { type: 'text.completed', text: 'Hello' },
]

const permissionScript: FakeStep[] = [
  { type: 'tool.started', toolId: 't1', name: 'Bash', kind: 'shell', summary: 'touch x', input: { command: 'touch x' } },
  {
    type: 'permission',
    toolId: 't1',
    name: 'Bash',
    kind: 'shell',
    summary: 'touch x',
    input: { command: 'touch x' },
    output: 'created',
  },
  { type: 'text.completed', text: 'Done' },
]

function recording(adapter: Adapter) {
  const calls: { options: SessionOptions; prompt?: string; closed: boolean }[] = []
  const wrapped: Adapter = {
    ...adapter,
    start(machine, options, emit) {
      const call: (typeof calls)[number] = { options, closed: false }
      calls.push(call)
      const session = adapter.start(machine, options, emit)
      return {
        ...session,
        prompt(text) {
          call.prompt = text
          session.prompt(text)
        },
        close() {
          call.closed = true
          session.close()
        },
      }
    },
  }
  return { adapter: wrapped, calls }
}

let dirs: string[] = []
let cores: Core[] = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  dirs.push(dir)
  return dir
}

function setup(source: FakeStep[] | Adapter, garage = tempDir()) {
  const { adapter, calls } = recording(Array.isArray(source) ? createFakeAdapter(source, 0) : source)
  return { ...open(garage, [adapter], adapter.id), calls }
}

function open(garage: string, adapters: Adapter[], defaultEngine: string) {
  const machine = localMachine
  const core = openCore({ garage, adapters, defaultEngine, machine, interruptGraceMs: TEST_INTERRUPT_GRACE_MS })
  cores.push(core)
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const replies: CoreMessage[] = []
  const handle = (m: Parameters<Core['handle']>[0]) => core.handle(m, (r) => replies.push(r))
  return { core, garage, messages, replies, handle }
}

function addProject(t: ReturnType<typeof open>, dir = tempDir()) {
  const before = [t.messages.length, t.replies.length]
  t.handle({ type: 'project.add', path: dir })
  const added = [...t.messages.slice(before[0]), ...t.replies.slice(before[1])].find((m) => m.type === 'project.added')
  if (added?.type !== 'project.added') throw new Error('no project.added')
  return added.project
}

function stubAdapter(start: Adapter['start']): Adapter {
  return { id: 'stub', detect: async () => ({ installed: true, signedIn: true }), start }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error('timed out')
}

const statusOf = (core: Core, id: string) => core.projects().find((p) => p.id === id)?.status
const entriesOf = (core: Core, id: string) => core.projects().find((p) => p.id === id)?.entries ?? []
const types = (entries: ChatEntry[]) => entries.map((e) => e.type)

beforeEach(() => {
  dirs = []
  cores = []
})

afterEach(() => {
  for (const core of cores) core.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('projects', () => {
  it('adds a folder once and keeps ids unique', () => {
    const t = setup(textScript)
    const parentA = tempDir()
    const parentB = tempDir()
    mkdirSync(join(parentA, 'app'))
    mkdirSync(join(parentB, 'app'))
    const first = addProject(t, join(parentA, 'app'))
    const again = addProject(t, join(parentA, 'app'))
    const second = addProject(t, join(parentB, 'app'))
    expect(first.id).toBe('app')
    expect(again.id).toBe('app')
    expect(second.id).not.toBe('app')
    expect(t.core.projects()).toHaveLength(2)
    const saved = JSON.parse(readFileSync(join(t.garage, 'projects', 'app', 'project.json'), 'utf8'))
    expect(saved).toEqual({ id: 'app', name: 'app', path: first.path, engine: 'fake' })
  })

  it('rejects a path that is not a directory', () => {
    const t = setup(textScript)
    const file = join(tempDir(), 'file.txt')
    writeFileSync(file, '')
    expect(() => t.handle({ type: 'project.add', path: file })).toThrow()
    expect(() => t.handle({ type: 'project.add', path: join(file, 'missing') })).toThrow()
  })
})

describe('chat', () => {
  it('streams a turn, saves it without deltas and closes the session', async () => {
    const t = setup(textScript)
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'hi' })
    expect(statusOf(t.core, project.id)).toBe('running')
    await until(() => statusOf(t.core, project.id) === 'idle')

    const deltas = t.messages.flatMap((m) => (m.type === 'chat.delta' ? [m.text] : []))
    expect(deltas.join('')).toBe('Hello')
    expect(types(entriesOf(t.core, project.id))).toEqual([
      'user.message',
      'turn.started',
      'text.completed',
      'turn.completed',
    ])
    const statuses = t.messages.flatMap((m) => (m.type === 'chat.status' ? [m.status] : []))
    expect(statuses).toEqual(['running', 'idle'])
    const log = readFileSync(join(t.garage, 'projects', project.id, 'chats', 'main', 'log.jsonl'), 'utf8')
    expect(log.trim().split('\n').map((l) => JSON.parse(l).type)).toEqual(types(entriesOf(t.core, project.id)))
    expect(t.calls[0]?.options.cwd).toBe(project.path)
    expect(t.calls[0]?.closed).toBe(true)
  })

  it('rejects a send while a turn runs', async () => {
    const t = setup(permissionScript)
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'one' })
    expect(() => t.handle({ type: 'chat.send', projectId: project.id, text: 'two' })).toThrow()
    expect(entriesOf(t.core, project.id).filter((e) => e.type === 'user.message')).toHaveLength(1)
  })

  it('keeps the log across a restart', async () => {
    const t = setup(textScript)
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'hi' })
    await until(() => statusOf(t.core, project.id) === 'idle')
    t.core.close()

    const reopened = setup(textScript, t.garage)
    expect(reopened.core.projects()).toEqual([{ ...project, status: 'idle', entries: entriesOf(t.core, project.id) }])
  })

  it('closes a turn that was cut off when Hotrod quit', () => {
    const t = setup(textScript)
    const project = addProject(t)
    const log = join(t.garage, 'projects', project.id, 'chats', 'main', 'log.jsonl')
    appendFileSync(log, JSON.stringify({ at: 'x', type: 'user.message', text: 'hi' }) + '\n')
    appendFileSync(log, JSON.stringify({ at: 'x', type: 'turn.started' }) + '\n')
    t.core.close()

    const reopened = setup(textScript, t.garage)
    const last = entriesOf(reopened.core, project.id).at(-1)
    expect(last?.type).toBe('turn.completed')
    expect(last?.type === 'turn.completed' && last.error).toBeTruthy()
    expect(statusOf(reopened.core, project.id)).toBe('idle')
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(3)
  })

  it('runs an allowed tool after permission', async () => {
    const t = setup(permissionScript)
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    await until(() => statusOf(t.core, project.id) === 'waiting')
    const request = entriesOf(t.core, project.id).find((e) => e.type === 'permission.requested')
    if (request?.type !== 'permission.requested') throw new Error('no request')

    t.handle({ type: 'permission.respond', projectId: project.id, requestId: request.requestId, allow: true })
    expect(statusOf(t.core, project.id)).toBe('running')
    await until(() => statusOf(t.core, project.id) === 'idle')
    const entries = entriesOf(t.core, project.id)
    expect(entries.find((e) => e.type === 'permission.resolved')).toMatchObject({ allow: true })
    expect(entries.find((e) => e.type === 'tool.completed')).toMatchObject({ output: 'created', isError: false })
  })

  it('reports a denied tool as an error', async () => {
    const t = setup(permissionScript)
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    await until(() => statusOf(t.core, project.id) === 'waiting')
    const request = entriesOf(t.core, project.id).find((e) => e.type === 'permission.requested')
    if (request?.type !== 'permission.requested') throw new Error('no request')

    t.handle({ type: 'permission.respond', projectId: project.id, requestId: request.requestId, allow: false })
    await until(() => statusOf(t.core, project.id) === 'idle')
    const entries = entriesOf(t.core, project.id)
    expect(entries.find((e) => e.type === 'permission.resolved')).toMatchObject({ allow: false })
    expect(entries.find((e) => e.type === 'tool.completed')).toMatchObject({ isError: true })
    expect(() =>
      t.handle({ type: 'permission.respond', projectId: project.id, requestId: request.requestId, allow: true }),
    ).toThrow()
  })

  it('interrupts a turn', async () => {
    const t = setup(permissionScript)
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    await until(() => statusOf(t.core, project.id) === 'waiting')
    t.handle({ type: 'chat.interrupt', projectId: project.id })
    await until(() => statusOf(t.core, project.id) === 'idle')
    expect(entriesOf(t.core, project.id).at(-1)?.type).toBe('turn.completed')
  })

  it('keeps tool and request ids unique across turns, even after a restart', async () => {
    const t = setup(permissionScript)
    const project = addProject(t)
    const runTurn = async (h: ReturnType<typeof setup>, allow: boolean) => {
      const before = entriesOf(h.core, project.id).length
      h.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
      await until(() => statusOf(h.core, project.id) === 'waiting')
      const request = entriesOf(h.core, project.id)
        .slice(before)
        .find((e) => e.type === 'permission.requested')
      if (request?.type !== 'permission.requested') throw new Error('no request')
      h.handle({ type: 'permission.respond', projectId: project.id, requestId: request.requestId, allow })
      await until(() => statusOf(h.core, project.id) === 'idle')
    }
    await runTurn(t, true)
    await runTurn(t, false)
    t.core.close()
    const reopened = setup(permissionScript, t.garage)
    await runTurn(reopened, true)

    const entries = entriesOf(reopened.core, project.id)
    const toolIds = entries.flatMap((e) => (e.type === 'tool.started' ? [e.toolId] : []))
    const requestIds = entries.flatMap((e) => (e.type === 'permission.requested' ? [e.requestId] : []))
    expect(new Set(toolIds).size).toBe(3)
    expect(new Set(requestIds).size).toBe(3)
    const results = entries.flatMap((e) => (e.type === 'tool.completed' ? [e.isError] : []))
    expect(results).toEqual([false, true, false])
  })

  it('saves the text streamed so far when a turn stops', async () => {
    const t = setup([
      { type: 'text.delta', text: 'First' },
      { type: 'text.completed', text: 'First' },
      { type: 'text.delta', text: 'Hel' },
      { type: 'text.delta', text: 'lo' },
      ...permissionScript,
    ])
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    await until(() => statusOf(t.core, project.id) === 'waiting')
    t.handle({ type: 'chat.interrupt', projectId: project.id })
    await until(() => statusOf(t.core, project.id) === 'idle')

    const entries = entriesOf(t.core, project.id)
    const texts = entries.flatMap((e) => (e.type === 'text.completed' ? [e.text] : []))
    expect(texts).toEqual(['First', 'Hello'])
    expect(types(entries).slice(-2)).toEqual(['text.completed', 'turn.completed'])
  })

  it('shows the text streamed so far to clients that join mid-turn', async () => {
    const t = setup([{ type: 'text.delta', text: 'Hel' }, { type: 'text.delta', text: 'lo' }, ...permissionScript])
    const project = addProject(t)
    expect(t.core.projects()[0]?.draft).toBe('')
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    await until(() => statusOf(t.core, project.id) === 'waiting')
    expect(t.core.projects()[0]?.draft).toBe('Hello')

    t.handle({ type: 'chat.interrupt', projectId: project.id })
    await until(() => statusOf(t.core, project.id) === 'idle')
    expect(t.core.projects()[0]?.draft).toBe('')
  })

  it('gives the engine the prior chat and the instructions', async () => {
    const t = setup(permissionScript)
    const dir = tempDir()
    writeFileSync(join(t.garage, 'AGENTS.md'), 'GLOBAL RULES')
    writeFileSync(join(dir, 'AGENTS.md'), 'REPO RULES')
    const project = addProject(t, dir)
    writeFileSync(join(t.garage, 'projects', project.id, 'AGENTS.md'), 'PERSONAL RULES')

    t.handle({ type: 'chat.send', projectId: project.id, text: 'first question' })
    await until(() => statusOf(t.core, project.id) === 'waiting')
    const request = entriesOf(t.core, project.id).find((e) => e.type === 'permission.requested')
    if (request?.type !== 'permission.requested') throw new Error('no request')
    t.handle({ type: 'permission.respond', projectId: project.id, requestId: request.requestId, allow: true })
    await until(() => statusOf(t.core, project.id) === 'idle')
    expect(t.calls[0]?.prompt).toBe('first question')

    t.handle({ type: 'chat.send', projectId: project.id, text: 'second question' })
    const prompt = t.calls[1]?.prompt ?? ''
    expect(prompt).toContain('first question')
    expect(prompt).toContain('Done')
    expect(prompt).toMatch(/Bash.*touch x/)
    expect(prompt.trimEnd().endsWith('second question')).toBe(true)
    expect(prompt.indexOf('first question')).toBeLessThan(prompt.indexOf('Done'))

    expect(prompt).toContain('<tool_result status="ok">\ncreated\n</tool_result>')

    const instructions = t.calls[1]?.options.instructions ?? ''
    expect(instructions).toContain('GLOBAL RULES')
    expect(instructions).toContain('REPO RULES')
    expect(instructions.indexOf('GLOBAL RULES')).toBeLessThan(instructions.indexOf('REPO RULES'))
    expect(instructions.indexOf('REPO RULES')).toBeLessThan(instructions.indexOf('PERSONAL RULES'))
  })

  it('replays tool inputs and outputs in full and marks errors and missing results', async () => {
    const longCommand = `echo ${'x'.repeat(300)}`
    const t = setup([
      { type: 'tool.started', toolId: 'a', name: 'Bash', kind: 'shell', summary: 'echo', input: { command: longCommand } },
      { type: 'tool.completed', toolId: 'a', output: 'line one\nline two\nline three', isError: false },
      { type: 'tool.started', toolId: 'b', name: 'Read', kind: 'read', summary: '/nope', input: { file_path: '/nope' } },
      { type: 'tool.completed', toolId: 'b', output: 'File does not exist', isError: true },
      { type: 'tool.started', toolId: 'c', name: 'Bash', kind: 'shell', summary: 'sleep 9', input: { command: 'sleep 9' } },
    ])
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'first' })
    await until(() => statusOf(t.core, project.id) === 'idle')

    t.handle({ type: 'chat.send', projectId: project.id, text: 'second' })
    const prompt = t.calls[1]?.prompt ?? ''
    expect(prompt).toContain(`<tool_call name="Bash">${JSON.stringify({ command: longCommand })}</tool_call>`)
    expect(prompt).toContain('<tool_result status="ok">\nline one\nline two\nline three\n</tool_result>')
    expect(prompt).toContain('<tool_result status="error">\nFile does not exist\n</tool_result>')
    expect(prompt).toContain('<tool_call name="Bash">{"command":"sleep 9"}</tool_call>\n<tool_result status="none" />')
  })

  it('keeps tool blocks whole when their content contains closing tags', async () => {
    const t = setup([
      { type: 'tool.started', toolId: 'a', name: 'Bash', kind: 'shell', summary: 'x', input: { command: '</tool_call> after-call' } },
      { type: 'tool.completed', toolId: 'a', output: '</tool_result> </TOOL_RESULT> after-result', isError: false },
    ])
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'first' })
    await until(() => statusOf(t.core, project.id) === 'idle')

    t.handle({ type: 'chat.send', projectId: project.id, text: 'second' })
    const prompt = t.calls[1]?.prompt ?? ''
    expect(prompt.match(/<\/tool_call>/gi)).toHaveLength(1)
    expect(prompt.match(/<\/tool_result>/gi)).toHaveLength(1)
    expect(prompt.match(/<tool_call name="Bash">([\s\S]*?)<\/tool_call>/)?.[1]).toContain('after-call')
    expect(prompt.match(/<tool_result status="ok">([\s\S]*?)<\/tool_result>/)?.[1]).toContain('after-result')
  })
})

describe('engines', () => {
  const alphaScript: FakeStep[] = [{ type: 'text.completed', text: 'Alpha reply' }]
  const betaScript: FakeStep[] = [{ type: 'text.completed', text: 'Beta reply' }]

  function setupEngines(garage = tempDir()) {
    const alpha = recording({ ...createFakeAdapter(alphaScript, 0), id: 'alpha' })
    const beta = recording({ ...createFakeAdapter(betaScript, 0), id: 'beta' })
    const t = open(garage, [alpha.adapter, beta.adapter], 'alpha')
    return { ...t, alpha: alpha.calls, beta: beta.calls }
  }

  const projectFile = (t: { garage: string }, id: string) => join(t.garage, 'projects', id, 'project.json')
  const engineOf = (core: Core, id: string) => core.projects().find((p) => p.id === id)?.engine

  it('rejects an unknown default engine', () => {
    expect(() => open(tempDir(), [createFakeAdapter([], 0)], 'nope')).toThrow(/Unknown engine "nope"/)
  })

  it('gives a new project the default engine and saves it', () => {
    const t = setupEngines()
    const project = addProject(t)
    expect(project.engine).toBe('alpha')
    expect(JSON.parse(readFileSync(projectFile(t, project.id), 'utf8')).engine).toBe('alpha')
  })

  it('gives a saved project without an engine the default', () => {
    const t = setupEngines()
    const project = addProject(t)
    const saved = JSON.parse(readFileSync(projectFile(t, project.id), 'utf8'))
    delete saved.engine
    writeFileSync(projectFile(t, project.id), JSON.stringify(saved))
    t.core.close()
    expect(engineOf(setupEngines(t.garage).core, project.id)).toBe('alpha')
  })

  it('sets a project engine, saves it and tells every client', () => {
    const t = setupEngines()
    const project = addProject(t)
    t.handle({ type: 'project.setEngine', projectId: project.id, engine: 'beta' })
    const { id, name, path } = project
    expect(t.messages.at(-1)).toEqual({ type: 'project.updated', project: { id, name, path, engine: 'beta' } })
    expect(engineOf(t.core, project.id)).toBe('beta')
    t.core.close()
    expect(engineOf(setupEngines(t.garage).core, project.id)).toBe('beta')
  })

  it('rejects an unknown engine and a change while a turn runs', () => {
    const t = setupEngines()
    const project = addProject(t)
    expect(() => t.handle({ type: 'project.setEngine', projectId: project.id, engine: 'nope' })).toThrow(
      /Unknown engine "nope"/,
    )
    t.handle({ type: 'chat.send', projectId: project.id, text: 'hi' })
    expect(() => t.handle({ type: 'project.setEngine', projectId: project.id, engine: 'beta' })).toThrow(/turn/)
    expect(engineOf(t.core, project.id)).toBe('alpha')
    expect(JSON.parse(readFileSync(projectFile(t, project.id), 'utf8')).engine).toBe('alpha')
  })

  it('continues a chat on another engine with the whole conversation', async () => {
    const t = setupEngines()
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'first question' })
    await until(() => statusOf(t.core, project.id) === 'idle')
    t.handle({ type: 'project.setEngine', projectId: project.id, engine: 'beta' })
    t.handle({ type: 'chat.send', projectId: project.id, text: 'second question' })
    await until(() => statusOf(t.core, project.id) === 'idle')

    expect(t.alpha).toHaveLength(1)
    expect(t.beta).toHaveLength(1)
    const prompt = t.beta[0]?.prompt ?? ''
    expect(prompt).toContain('User: first question')
    expect(prompt).toContain('Assistant: Alpha reply')
    expect(prompt.trimEnd().endsWith('second question')).toBe(true)
    const texts = entriesOf(t.core, project.id).flatMap((e) => (e.type === 'text.completed' ? [e.text] : []))
    expect(texts).toEqual(['Alpha reply', 'Beta reply'])
  })

  it('keeps a project whose saved engine is gone and refuses to send', () => {
    const t = setupEngines()
    const project = addProject(t)
    writeFileSync(projectFile(t, project.id), JSON.stringify({ ...project, engine: 'removed' }))
    t.core.close()

    const reopened = setupEngines(t.garage)
    expect(engineOf(reopened.core, project.id)).toBe('removed')
    expect(() => reopened.handle({ type: 'chat.send', projectId: project.id, text: 'hi' })).toThrow(
      /Engine "removed" is not available/,
    )
    expect(entriesOf(reopened.core, project.id)).toEqual([])
    expect(statusOf(reopened.core, project.id)).toBe('idle')
    reopened.handle({ type: 'project.setEngine', projectId: project.id, engine: 'beta' })
    reopened.handle({ type: 'chat.send', projectId: project.id, text: 'hi' })
    expect(reopened.beta).toHaveLength(1)
  })
})

describe('interrupt', () => {
  it('ends the turn when the engine ignores the interrupt', async () => {
    let emitLate: ((event: EngineEvent) => void) | undefined
    const t = setup(
      stubAdapter((_machine, _options, emit) => {
        emitLate = emit
        return {
          prompt() {
            emit({ type: 'turn.started' })
            emit({ type: 'text.delta', text: 'partial' })
          },
          interrupt() {},
          respond() {},
          close() {},
        }
      }),
    )
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    t.handle({ type: 'chat.interrupt', projectId: project.id })
    expect(statusOf(t.core, project.id)).toBe('running')
    await until(() => statusOf(t.core, project.id) === 'idle')

    const entries = entriesOf(t.core, project.id)
    expect(entries.slice(-2)).toMatchObject([
      { type: 'text.completed', text: 'partial' },
      { type: 'turn.completed', error: 'Interrupted' },
    ])
    expect(t.calls[0]?.closed).toBe(true)
    emitLate?.({ type: 'turn.completed' })
    expect(entriesOf(t.core, project.id)).toHaveLength(entries.length)
  })

  it('ends an interrupted turn once when the engine stops in time', async () => {
    const t = setup(permissionScript)
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    await until(() => statusOf(t.core, project.id) === 'waiting')
    t.handle({ type: 'chat.interrupt', projectId: project.id })
    await until(() => statusOf(t.core, project.id) === 'idle')
    await new Promise((r) => setTimeout(r, TEST_INTERRUPT_GRACE_MS * 3))
    expect(entriesOf(t.core, project.id).filter((e) => e.type === 'turn.completed')).toHaveLength(1)
  })
})

describe('engine failures', () => {
  it('records an engine that throws on start and stays usable', () => {
    const t = setup(
      stubAdapter(() => {
        throw new Error('claude: command not found')
      }),
    )
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'hi' })
    expect(statusOf(t.core, project.id)).toBe('idle')
    const last = entriesOf(t.core, project.id).at(-1)
    expect(last).toMatchObject({ type: 'turn.completed', error: expect.stringContaining('command not found') })
    expect(t.messages).toContainEqual({ type: 'chat.entry', projectId: project.id, entry: last })
    expect(t.messages.flatMap((m) => (m.type === 'chat.status' ? [m.status] : []))).toEqual(['running', 'idle'])
    expect(() => t.handle({ type: 'chat.send', projectId: project.id, text: 'again' })).not.toThrow()
  })

  it('records an engine process that fails to spawn', async () => {
    const t = setup(
      stubAdapter((machine, options, emit) => {
        const proc = machine.spawn('hotrod-test-missing-engine', [], { cwd: options.cwd })
        let stderr = ''
        proc.onStderr((chunk) => (stderr += chunk))
        proc.onExit((code) => emit({ type: 'session.ended', error: stderr || `exited with code ${code}` }))
        return {
          prompt(text) {
            proc.write(text)
            emit({ type: 'turn.started' })
          },
          interrupt() {},
          respond() {},
          close: () => proc.kill(),
        }
      }),
    )
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'hi' })
    await until(() => statusOf(t.core, project.id) === 'idle')
    const last = entriesOf(t.core, project.id).at(-1)
    expect(last).toMatchObject({ type: 'session.ended', error: expect.stringContaining('ENOENT') })
  })

  it('does not prompt an engine that ended while starting', () => {
    let prompted = false
    const t = setup(
      stubAdapter((_machine, _options, emit) => {
        emit({ type: 'session.ended', error: 'no engine' })
        return {
          prompt() {
            prompted = true
            emit({ type: 'turn.started' })
          },
          interrupt() {},
          respond() {},
          close() {},
        }
      }),
    )
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'hi' })
    expect(statusOf(t.core, project.id)).toBe('idle')
    expect(types(entriesOf(t.core, project.id))).toEqual(['user.message', 'session.ended'])
    expect(prompted).toBe(false)
    expect(t.calls[0]?.closed).toBe(true)
  })
})
