import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension, ExtensionChat } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, type FakeStep } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore, type Core } from './core.ts'
import { openEngineTools, toolRowsOf, type Provided } from './engine-tools.ts'
import type { Adapter, EngineToolSpec, SessionOptions } from './shared.ts'
import { until } from './test-wait.ts'

const TOOLS: EngineToolSpec[] = [
  { name: 'Bash', capability: 'shell', group: 'core' },
  { name: 'Grep', capability: 'search', group: 'core', on: false },
  { name: 'Agent', capability: 'subagents', group: 'replaced' },
  { name: 'TodoWrite', capability: 'todos', group: 'replaced' },
  { name: 'CronCreate', capability: 'scheduling', group: 'outside' },
]
const WORKERS: Provided = new Map([['subagents', 'Workers']])

let dirs: string[] = []
let cores: Core[] = []
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-tools-')))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(cores.map((core) => core.close(true)))
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
  cores = []
})

describe('toolRowsOf', () => {
  it('gives each group its default: core on, replaced off while Kothar has its version, outside off', () => {
    const rows = toolRowsOf(TOOLS, undefined, undefined, WORKERS)
    expect(rows.map(({ name, on, defaultOn }) => [name, on, defaultOn])).toEqual([
      ['Bash', true, true],
      ['Grep', false, false],
      ['Agent', false, false],
      ['TodoWrite', true, true],
      ['CronCreate', false, false],
    ])
    expect(rows.find((row) => row.name === 'Agent')?.replacedBy).toBe('Workers')
    expect(toolRowsOf(TOOLS, undefined, undefined, new Map()).find((row) => row.name === 'Agent')?.on).toBe(true)
  })

  it("lets the user's choice beat the default, core tools included, and marks it saved", () => {
    const rows = toolRowsOf(TOOLS, undefined, { Bash: false, CronCreate: true }, WORKERS)
    expect(rows.find((row) => row.name === 'Bash')).toMatchObject({ on: false, defaultOn: true, saved: true })
    expect(rows.find((row) => row.name === 'CronCreate')).toMatchObject({ on: true, saved: true })
    expect(rows.find((row) => row.name === 'Agent')?.saved).toBeUndefined()
  })

  it('adds tools the engine reported that the adapter does not know, on and marked new', () => {
    const rows = toolRowsOf(TOOLS, ['Bash', 'Shiny'], undefined, WORKERS)
    expect(rows.at(-1)).toEqual({ name: 'Shiny', group: 'core', isNew: true, defaultOn: true, on: true })
    expect(rows.filter((row) => row.name === 'Bash')).toHaveLength(1)
  })
})

describe('openEngineTools', () => {
  const adapter = { ...createFakeAdapter([], 0), tools: TOOLS } as Adapter
  const open = (engineTools?: object, garage = tempDir()) => {
    const settings: { engineTools?: any } = engineTools ? { engineTools } : {}
    const saved: unknown[] = []
    const tools = openEngineTools({ garage, settings, saveSettings: () => saved.push(1), adapterFor: (id) => (id === 'fake' ? adapter : undefined) })
    return { tools, garage }
  }

  it("gives a session the off and on tools by the engine's names, and nothing for an engine that can't switch", () => {
    const { tools } = open({ engines: { fake: { tools: { TodoWrite: false } } } })
    expect(tools.sessionFor('fake', WORKERS)).toEqual({
      tools: { off: ['Grep', 'Agent', 'TodoWrite', 'CronCreate'], on: ['Bash'] },
    })
    expect(tools.sessionFor('other', WORKERS)).toEqual({})
  })

  it('turns every tool off with either master switch off, keeping the per-tool choices as they were', () => {
    const choices = { TodoWrite: false }
    const global = open({ enabled: false, engines: { fake: { tools: choices } } }).tools.sessionFor('fake', WORKERS)
    expect(global).toMatchObject({ noTools: true, tools: { off: ['Grep', 'Agent', 'TodoWrite', 'CronCreate'] } })
    const engine = open({ engines: { fake: { enabled: false, tools: choices } } }).tools.sessionFor('fake', WORKERS)
    expect(engine.noTools).toBe(true)
    expect(open({ engines: { fake: { tools: choices } } }).tools.sessionFor('fake', WORKERS).noTools).toBeUndefined()
  })

  it('keeps the tools an engine reported in engine-tools.json, read back on the next start', () => {
    const { tools, garage } = open()
    tools.record('fake', ['Bash', 'Shiny', 'Shiny'])
    expect(JSON.parse(readFileSync(join(garage, 'engine-tools.json'), 'utf8'))).toEqual({ fake: ['Bash', 'Shiny'] })
    const again = open(undefined, garage).tools
    expect(again.rowsOf('fake', WORKERS).at(-1)).toMatchObject({ name: 'Shiny', isNew: true })
  })

  it('saves a tool choice, any tool core ones included, drops one back at its default, and resets an engine', () => {
    const settings: { engineTools?: any } = {}
    const messages: any[] = []
    const tools = openEngineTools({
      garage: tempDir(),
      settings,
      saveSettings: () => {},
      adapterFor: (id) => (id === 'fake' ? adapter : undefined),
      adapters: () => [adapter, createFakeAdapter([], 0)],
      provided: () => WORKERS,
      broadcast: (m) => messages.push(m),
    })
    tools.setTool('fake', 'Bash', false)
    tools.setTool('fake', 'CronCreate', true)
    expect(settings.engineTools).toEqual({ engines: { fake: { tools: { Bash: false, CronCreate: true } } } })
    expect(messages.at(-1).engineTools.engines).toEqual([
      expect.objectContaining({ engine: 'fake', enabled: true, tools: expect.arrayContaining([expect.objectContaining({ name: 'Bash', on: false, saved: true })]) }),
    ])
    tools.setTool('fake', 'Bash', undefined)
    expect(settings.engineTools).toEqual({ engines: { fake: { tools: { CronCreate: true } } } })
    expect(() => tools.setTool('fake', 'Nope', true)).toThrow('no tool "Nope"')
    expect(() => tools.setTool('missing', 'Bash', true)).toThrow('No engine')
    tools.reset('fake')
    expect(settings.engineTools).toBeUndefined()
  })

  it('keeps the per-tool choices under either master switch, so turning it back on restores them', () => {
    const settings: { engineTools?: any } = { engineTools: { engines: { fake: { tools: { Bash: false } } } } }
    const tools = openEngineTools({ garage: tempDir(), settings, saveSettings: () => {}, adapterFor: () => adapter, adapters: () => [adapter] })
    tools.setEnabled(undefined, false)
    tools.setEnabled('fake', false)
    expect(settings.engineTools).toEqual({ enabled: false, engines: { fake: { enabled: false, tools: { Bash: false } } } })
    expect(tools.info()).toMatchObject({ enabled: false, engines: [{ engine: 'fake', enabled: false }] })
    tools.setEnabled(undefined, true)
    tools.setEnabled('fake', true)
    expect(settings.engineTools).toEqual({ engines: { fake: { tools: { Bash: false } } } })
    expect(tools.sessionFor('fake', WORKERS).tools?.off).toContain('Bash')
    expect(() => tools.setEnabled(undefined, 'yes')).toThrow()
  })

  it('reads a broken engine-tools.json as empty', () => {
    const garage = tempDir()
    writeFileSync(join(garage, 'engine-tools.json'), '{not json')
    expect(open(undefined, garage).tools.reported('fake')).toBeUndefined()
  })
})

describe('engine tools in a turn', () => {
  const MAIN: ExtensionChat = { id: 'main', name: 'Main', instructions: 'MAIN ROLE', seesAll: true }
  const mainExtension: Extension = { id: 'main-extension', name: 'Main', description: '', enabledByDefault: true, chats: [MAIN] }

  function setup(script: FakeStep[], saved?: object, more: Extension[] = []) {
    const garage = tempDir()
    if (saved) writeFileSync(join(garage, 'settings.json'), JSON.stringify({ engineTools: saved }))
    const calls: SessionOptions[] = []
    const fake = { ...createFakeAdapter(script, 0), tools: TOOLS }
    const adapter: Adapter = { ...fake, start: (machine, options, emit) => (calls.push(options), fake.start(machine, options, emit)) }
    const core = openCore({ garage, adapters: [adapter], defaultEngine: 'fake', machine: sandboxingMachine, extensions: [mainExtension, ...more] })
    cores.push(core)
    core.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true }, () => {})
    core.handle({ type: 'workFolder.set', path: join(garage, 'work') }, () => {})
    const send = () => core.handle({ type: 'chat.send', chatId: 'main', text: 'hi' }, () => {})
    return { core, garage, calls, send }
  }

  it("starts each session with the engine's tools as Settings has them, workers standing in for subagents", async () => {
    const t = setup([{ type: 'text.completed', text: 'ok' }], { engines: { fake: { tools: { CronCreate: true } } } })
    t.send()
    await until(() => t.calls.length === 1)
    expect(t.calls[0]!.tools).toEqual({ off: ['Grep', 'Agent'], on: ['Bash', 'TodoWrite', 'CronCreate'] })
    expect(t.calls[0]!.noTools).toBeUndefined()
  })

  it('starts sessions with no tools of their own while the master switch is off', async () => {
    const t = setup([{ type: 'text.completed', text: 'ok' }], { enabled: false })
    t.send()
    await until(() => t.calls.length === 1)
    expect(t.calls[0]!.noTools).toBe(true)
  })

  it('changes tools over the protocol and labels what was off in What was sent', async () => {
    const sentTurns: any[] = []
    const inspector: Extension = {
      id: 'inspector',
      name: 'Inspector',
      description: '',
      enabledByDefault: true,
      onTurnSent: (turn) => void sentTurns.push(turn),
    }
    const garage = tempDir()
    const fake = { ...createFakeAdapter([{ type: 'text.completed', text: 'ok' }], 0), tools: TOOLS }
    const core = openCore({ garage, adapters: [fake], defaultEngine: 'fake', machine: sandboxingMachine, extensions: [mainExtension, inspector] })
    cores.push(core)
    core.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true }, () => {})
    core.handle({ type: 'workFolder.set', path: join(garage, 'work') }, () => {})
    expect(core.engineTools()).toMatchObject({ enabled: true, engines: [{ engine: 'fake', enabled: true }] })
    core.handle({ type: 'engineTools.setTool', engine: 'fake', tool: 'Bash', on: false }, () => {})
    core.handle({ type: 'chat.send', chatId: 'main', text: 'hi' }, () => {})
    await until(() => sentTurns.length === 1 && core.chats().find((c) => c.id === 'main')?.status === 'idle')
    const offSection = sentTurns[0].sections.find((s: any) => s.label === "Fake's own tools turned off")
    expect(offSection.text).toContain('Bash, Grep, Agent, CronCreate')
    core.handle({ type: 'engineTools.setEnabled', enabled: false }, () => {})
    core.handle({ type: 'chat.send', chatId: 'main', text: 'again' }, () => {})
    await until(() => sentTurns.length === 2)
    const none = sentTurns[1].sections.find((s: any) => s.label === "Fake's own tools: all off")
    expect(none.text).toContain("Only MCP tools were left")
  })

  it("turns off an engine's tools an extension that's on replaces, unless the user turned them back on", async () => {
    const todos: Extension = { id: 'todos', name: 'Todos', description: '', enabledByDefault: true, replaces: ['todos'] }
    const t = setup([{ type: 'text.completed', text: 'ok' }], undefined, [todos])
    expect(t.core.engineTools().engines[0]!.tools.find((tool) => tool.name === 'TodoWrite')).toMatchObject({
      on: false,
      defaultOn: false,
      replacedBy: 'Todos',
    })
    t.send()
    await until(() => t.calls.length === 1 && t.core.chats().find((c) => c.id === 'main')?.status === 'idle')
    expect(t.calls[0]!.tools?.off).toContain('TodoWrite')

    t.core.handle({ type: 'engineTools.setTool', engine: 'fake', tool: 'TodoWrite', on: true }, () => {})
    t.send()
    await until(() => t.calls.length === 2 && t.core.chats().find((c) => c.id === 'main')?.status === 'idle')
    expect(t.calls[1]!.tools?.on).toContain('TodoWrite')

    t.core.handle({ type: 'engineTools.reset', engine: 'fake' }, () => {})
    t.core.handle({ type: 'extension.setEnabled', extensionId: 'todos', enabled: false }, () => {})
    expect(t.core.engineTools().engines[0]!.tools.find((tool) => tool.name === 'TodoWrite')?.on).toBe(true)
    t.send()
    await until(() => t.calls.length === 3)
    expect(t.calls[2]!.tools?.on).toContain('TodoWrite')
  })

  it('records the tools a session reports', async () => {
    const t = setup([{ type: 'tools.listed', names: ['Bash', 'Shiny'] }, { type: 'text.completed', text: 'ok' }])
    t.send()
    const file = join(t.garage, 'engine-tools.json')
    await until(() => {
      try {
        return JSON.parse(readFileSync(file, 'utf8')).fake?.length === 2
      } catch {
        return false
      }
    })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fake: ['Bash', 'Shiny'] })
  })
})
