import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, type FakeStep } from './adapters/fake.ts'
import { openCore, type Core } from './core.ts'
import { localMachine } from './machine.ts'
import type { Adapter, ChatEntry, CoreMessage, EngineEvent, SessionOptions } from './types.ts'

const TEST_STOP_GRACE_MS = 30

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
  const calls: { options: SessionOptions; prompt?: string; interrupted?: boolean; closed: boolean }[] = []
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
        interrupt() {
          call.interrupted = true
          session.interrupt()
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

function setup(source: FakeStep[] | Adapter, garage = tempDir(), stopGraceMs = TEST_STOP_GRACE_MS) {
  const { adapter, calls } = recording(Array.isArray(source) ? createFakeAdapter(source, 0) : source)
  return { ...open(garage, [adapter], adapter.id, stopGraceMs), calls }
}

function open(garage: string, adapters: Adapter[], defaultEngine: string, stopGraceMs = TEST_STOP_GRACE_MS) {
  const machine = localMachine
  const core = openCore({ garage, adapters, defaultEngine, machine, stopGraceMs })
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

afterEach(async () => {
  await Promise.all(cores.map((core) => core.close(true)))
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

  it('streams thinking live without saving or replaying it', async () => {
    const t = setup([{ type: 'thinking.delta', text: 'Hmm, ' }, { type: 'thinking.delta', text: 'SECRET' }, ...textScript])
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'hi' })
    await until(() => statusOf(t.core, project.id) === 'idle')

    const thinking = t.messages.flatMap((m) => (m.type === 'chat.thinking' ? [m.text] : []))
    expect(thinking.join('')).toBe('Hmm, SECRET')
    expect(types(entriesOf(t.core, project.id))).toEqual(['user.message', 'turn.started', 'text.completed', 'turn.completed'])
    const log = readFileSync(join(t.garage, 'projects', project.id, 'chats', 'main', 'log.jsonl'), 'utf8')
    expect(log).not.toContain('SECRET')

    t.handle({ type: 'chat.send', projectId: project.id, text: 'again' })
    expect(t.calls[1]?.prompt).not.toContain('SECRET')
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
  const ignoresInterrupt = (onInterrupt: (emit: (event: EngineEvent) => void) => void = () => {}) =>
    stubAdapter((_machine, _options, emit) => ({
      prompt() {
        emit({ type: 'turn.started' })
        emit({ type: 'text.delta', text: 'partial' })
      },
      interrupt: () => onInterrupt(emit),
      respond() {},
      close() {},
    }))

  it('shows the chat as stopping, then force-stops an engine that ignores the interrupt', async () => {
    let emitLate: ((event: EngineEvent) => void) | undefined
    const t = setup(ignoresInterrupt((emit) => (emitLate = emit)))
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    t.handle({ type: 'chat.interrupt', projectId: project.id })
    expect(statusOf(t.core, project.id)).toBe('stopping')
    expect(t.messages).toContainEqual({ type: 'chat.status', projectId: project.id, status: 'stopping' })
    await until(() => statusOf(t.core, project.id) === 'idle')

    const entries = entriesOf(t.core, project.id)
    expect(entries.slice(-2)).toMatchObject([
      { type: 'text.completed', text: 'partial' },
      { type: 'turn.completed', error: 'Interrupted' },
    ])
    expect(t.calls[0]).toMatchObject({ closed: true })
    emitLate?.({ type: 'turn.completed' })
    expect(entriesOf(t.core, project.id)).toHaveLength(entries.length)
  })

  it('force-stops at once when asked, keeping the text streamed so far', () => {
    const t = setup(ignoresInterrupt())
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    t.handle({ type: 'chat.interrupt', projectId: project.id })
    t.handle({ type: 'chat.interrupt', projectId: project.id, force: true })
    expect(statusOf(t.core, project.id)).toBe('idle')
    expect(entriesOf(t.core, project.id).slice(-2)).toMatchObject([
      { type: 'text.completed', text: 'partial' },
      { type: 'turn.completed', error: 'Interrupted' },
    ])
    expect(t.calls[0]).toMatchObject({ closed: true })
  })

  it('stays stopping while the engine winds down', () => {
    const t = setup(
      ignoresInterrupt((emit) =>
        emit({ type: 'permission.requested', requestId: 'r1', name: 'Bash', kind: 'shell', summary: 'ls', input: {} }),
      ),
    )
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    t.handle({ type: 'chat.interrupt', projectId: project.id })
    expect(statusOf(t.core, project.id)).toBe('stopping')
  })

  it('closes a session gently once the engine stops in time', async () => {
    const t = setup(permissionScript)
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    await until(() => statusOf(t.core, project.id) === 'waiting')
    t.handle({ type: 'chat.interrupt', projectId: project.id })
    await until(() => statusOf(t.core, project.id) === 'idle')
    expect(t.calls[0]).toMatchObject({ closed: true })
    await new Promise((r) => setTimeout(r, TEST_STOP_GRACE_MS * 3))
    expect(entriesOf(t.core, project.id).filter((e) => e.type === 'turn.completed')).toHaveLength(1)
  })

})

describe('quit', () => {
  const ignoresInterrupt = () =>
    stubAdapter((_machine, _options, emit) => ({
      prompt() {
        emit({ type: 'turn.started' })
        emit({ type: 'text.delta', text: 'partial' })
      },
      interrupt() {},
      respond() {},
      close() {},
    }))

  it('asks a busy engine to stop first and closes its session once the turn ends', async () => {
    const t = setup(permissionScript)
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    await until(() => statusOf(t.core, project.id) === 'waiting')
    await t.core.close()
    expect(t.calls[0]).toMatchObject({ interrupted: true, closed: true })
    expect(entriesOf(t.core, project.id).at(-1)).toMatchObject({ type: 'turn.completed', error: 'Interrupted' })
  })

  it('shows a busy chat as stopping and forces it after the stop grace', async () => {
    const t = setup(ignoresInterrupt())
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    let closed = false
    const closing = t.core.close().then(() => (closed = true))
    expect(t.calls[0]).toMatchObject({ interrupted: true, closed: false })
    expect(statusOf(t.core, project.id)).toBe('stopping')
    expect(closed).toBe(false)
    await closing
    expect(t.calls[0]?.closed).toBe(true)
    expect(entriesOf(t.core, project.id).slice(-2)).toMatchObject([
      { type: 'text.completed', text: 'partial' },
      { type: 'turn.completed', error: 'Interrupted' },
    ])
  })

  it('skips the interrupt on a forced quit and closes every session at once', async () => {
    const t = setup(ignoresInterrupt())
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    await t.core.close(true)
    expect(t.calls[0]).toMatchObject({ closed: true })
    expect(t.calls[0]?.interrupted).toBeUndefined()
    expect(statusOf(t.core, project.id)).toBe('idle')
  })

  it('ends a waiting quit when it is forced', async () => {
    const longGraceMs = 60_000
    const t = setup(ignoresInterrupt(), tempDir(), longGraceMs)
    const project = addProject(t)
    t.handle({ type: 'chat.send', projectId: project.id, text: 'go' })
    const start = performance.now()
    const closing = t.core.close()
    await t.core.close(true)
    await closing
    expect(performance.now() - start).toBeLessThan(longGraceMs / 2)
    expect(t.calls[0]).toMatchObject({ interrupted: true, closed: true })
  })

  it('refuses new messages while quitting', () => {
    const t = setup(ignoresInterrupt())
    const busy = addProject(t)
    const idle = addProject(t)
    t.handle({ type: 'chat.send', projectId: busy.id, text: 'go' })
    void t.core.close()
    expect(() => t.handle({ type: 'chat.send', projectId: idle.id, text: 'hi' })).toThrow(/quitting/)
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
        proc.onExit((code, stderr) => emit({ type: 'session.ended', error: stderr || `exited with code ${code}` }))
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

describe('accounts', () => {
  function setupAccounts(script: FakeStep[] = textScript, garage = tempDir()) {
    const logouts: string[] = []
    const fake = createFakeAdapter(script, 0)
    const logout = async (_machine: unknown, dir: string) => void logouts.push(dir)
    const adapter: Adapter = { ...fake, accounts: { ...fake.accounts!, logout } }
    const { adapter: wrapped, calls } = recording(adapter)
    return { ...open(garage, [wrapped, { ...stubAdapter(() => ({}) as never), id: 'plain' }], 'fake'), calls, logouts }
  }

  const accountsOf = (core: Core) => core.accounts().find((a) => a.engine === 'fake')!
  const accountDir = (garage: string, id: string) => join(garage, 'accounts', 'fake', id)

  async function signIn(t: ReturnType<typeof setupAccounts>, name: string) {
    t.handle({ type: 'account.login', engine: 'fake', name })
    await until(() => accountsOf(t.core).login?.url !== undefined)
    t.handle({ type: 'account.code', engine: 'fake', code: 'ok' })
    await until(() => !accountsOf(t.core).login)
  }

  it("lists the engine's own login as the default account, only for engines with accounts", async () => {
    const t = setupAccounts()
    await t.core.refreshAccounts()
    expect(t.core.accounts()).toEqual([
      {
        engine: 'fake',
        active: 'default',
        apiKeys: true,
        accounts: [{ id: 'default', name: 'Default', kind: 'login', label: 'default@fake.test', signedIn: true }],
      },
    ])
  })

  it('signs in a new account in its own folder and keeps it across a restart', async () => {
    const t = setupAccounts()
    t.handle({ type: 'account.login', engine: 'fake', name: 'Work' })
    expect(t.messages.at(-1)).toMatchObject({ type: 'accounts.updated', accounts: { login: { name: 'Work' } } })
    await until(() => accountsOf(t.core).login?.url !== undefined)
    expect(() => t.handle({ type: 'account.login', engine: 'fake', name: 'Other' })).toThrow(/already/)
    t.handle({ type: 'account.code', engine: 'fake', code: 'ok' })
    await until(() => !accountsOf(t.core).login)

    const work = { id: 'work', name: 'Work', kind: 'login', label: 'work@fake.test', signedIn: true }
    expect(accountsOf(t.core).accounts.at(-1)).toEqual(work)
    expect(existsSync(accountDir(t.garage, 'work'))).toBe(true)
    await signIn(t, 'work')
    expect(accountsOf(t.core).accounts.map((a) => a.id)).toEqual(['default', 'work', 'work-2'])

    const reopened = setupAccounts(textScript, t.garage)
    await reopened.core.refreshAccounts()
    expect(accountsOf(reopened.core).accounts.map((a) => a.id)).toEqual(['default', 'work', 'work-2'])
  })

  it('reports a failed sign-in, removes its folder and clears it on cancel', async () => {
    const t = setupAccounts()
    t.handle({ type: 'account.login', engine: 'fake', name: 'Work' })
    await until(() => accountsOf(t.core).login?.url !== undefined)
    t.handle({ type: 'account.code', engine: 'fake', code: 'fail' })
    await until(() => accountsOf(t.core).login?.error !== undefined)
    expect(existsSync(accountDir(t.garage, 'work'))).toBe(false)
    t.handle({ type: 'account.cancelLogin', engine: 'fake' })
    expect(accountsOf(t.core).login).toBeUndefined()
    expect(accountsOf(t.core).accounts.map((a) => a.id)).toEqual(['default'])
  })

  it('starts sessions with the active account and switches only while idle', async () => {
    const t = setupAccounts(permissionScript)
    await signIn(t, 'Work')
    const project = addProject(t)

    t.handle({ type: 'account.use', engine: 'fake', accountId: 'work' })
    expect(accountsOf(t.core).active).toBe('work')
    t.handle({ type: 'chat.send', projectId: project.id, text: 'hi' })
    expect(t.calls[0]?.options.accountDir).toBe(accountDir(t.garage, 'work'))
    await until(() => statusOf(t.core, project.id) === 'waiting')
    expect(() => t.handle({ type: 'account.use', engine: 'fake', accountId: 'default' })).toThrow(/turn/)
    expect(() => t.handle({ type: 'account.use', engine: 'fake', accountId: 'nope' })).toThrow(/Unknown account/)
    t.handle({ type: 'chat.interrupt', projectId: project.id })
    await until(() => statusOf(t.core, project.id) === 'idle')

    t.handle({ type: 'account.use', engine: 'fake', accountId: 'default' })
    t.handle({ type: 'chat.send', projectId: project.id, text: 'again' })
    expect(t.calls[1]?.options.accountDir).toBeUndefined()
    const reopened = setupAccounts(textScript, t.garage)
    expect(accountsOf(reopened.core).active).toBe('default')
  })

  it('removes an account: logs it out, deletes its folder and falls back to the default', async () => {
    const t = setupAccounts()
    await signIn(t, 'Work')
    t.handle({ type: 'account.use', engine: 'fake', accountId: 'work' })
    expect(() => t.handle({ type: 'account.remove', engine: 'fake', accountId: 'default' })).toThrow(/default/)
    t.handle({ type: 'account.remove', engine: 'fake', accountId: 'work' })
    await until(() => accountsOf(t.core).accounts.length === 1)
    expect(t.logouts).toEqual([accountDir(t.garage, 'work')])
    expect(existsSync(accountDir(t.garage, 'work'))).toBe(false)
    expect(accountsOf(t.core).active).toBe('default')
  })

  it('rejects account messages for an engine without accounts', () => {
    const t = setupAccounts()
    expect(() => t.handle({ type: 'account.login', engine: 'plain', name: 'Work' })).toThrow(/accounts/)
  })

  describe('API keys', () => {
    const key = 'sk-ant-test-0000-secret-1234abcd'
    const addKey = (t: ReturnType<typeof setupAccounts>, name = 'Billing', apiKey = `  ${key}\n`) =>
      t.handle({ type: 'account.addApiKey', engine: 'fake', name, key: apiKey })

    it('keeps the key in a 0600 file in its own folder and shows only its last 4 characters', async () => {
      const t = setupAccounts()
      addKey(t)
      const label = 'API key ••••abcd'
      const billing = { id: 'billing', name: 'Billing', kind: 'apiKey', label, signedIn: true }
      expect(accountsOf(t.core).accounts.at(-1)).toEqual(billing)
      const keyFile = join(accountDir(t.garage, 'billing'), 'api-key')
      expect(readFileSync(keyFile, 'utf8')).toBe(key)
      expect(statSync(keyFile).mode & 0o777).toBe(0o600)
      expect(readFileSync(join(t.garage, 'accounts', 'fake.json'), 'utf8')).not.toContain(key)
      expect(JSON.stringify([t.messages, t.replies, t.core.accounts()])).not.toContain(key)

      await t.core.refreshAccounts()
      const reopened = setupAccounts(textScript, t.garage)
      await reopened.core.refreshAccounts()
      expect(accountsOf(reopened.core).accounts.at(-1)).toEqual(billing)
    })

    it('starts sessions with the key and its folder, and never writes the key to the chat log', async () => {
      const t = setupAccounts()
      addKey(t)
      const project = addProject(t)
      t.handle({ type: 'account.use', engine: 'fake', accountId: 'billing' })
      t.handle({ type: 'chat.send', projectId: project.id, text: 'hi' })
      expect(t.calls[0]?.options).toMatchObject({ accountDir: accountDir(t.garage, 'billing'), apiKey: key })
      await until(() => statusOf(t.core, project.id) === 'idle')
      const log = readFileSync(join(t.garage, 'projects', project.id, 'chats', 'main', 'log.jsonl'), 'utf8')
      expect(log).not.toContain(key)
      expect(JSON.stringify(t.messages)).not.toContain(key)
    })

    it('removes a key account without signing out', async () => {
      const t = setupAccounts()
      addKey(t)
      t.handle({ type: 'account.remove', engine: 'fake', accountId: 'billing' })
      await until(() => accountsOf(t.core).accounts.length === 1)
      expect(t.logouts).toEqual([])
      expect(existsSync(accountDir(t.garage, 'billing'))).toBe(false)
    })

    it('rejects an empty or spaced key without echoing it, and engines without key support', () => {
      const t = setupAccounts()
      expect(() => addKey(t, 'Billing', '   ')).toThrow(/Paste/)
      let error = ''
      try {
        addKey(t, 'Billing', 'sk-ant one')
      } catch (e) {
        error = String(e)
      }
      expect(error).toMatch(/space/)
      expect(error).not.toContain('sk-ant')
      expect(() => addKey(t, ' ')).toThrow(/name/)
      expect(accountsOf(t.core).accounts.map((a) => a.id)).toEqual(['default'])
      expect(existsSync(join(t.garage, 'accounts', 'fake', 'billing'))).toBe(false)

      const fake = createFakeAdapter(textScript, 0)
      const noKeys: Adapter = { ...fake, id: 'nokeys', accounts: { ...fake.accounts!, apiKeys: false } }
      const plain = open(tempDir(), [noKeys], 'nokeys')
      expect(plain.core.accounts()[0]?.apiKeys).toBe(false)
      const message = { type: 'account.addApiKey', engine: 'nokeys', name: 'Billing', key } as const
      expect(() => plain.handle(message)).toThrow(/API keys/)
    })
  })
})
