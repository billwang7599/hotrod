import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatSummary, Extension, ExtensionHost, ExtensionValues } from '@kothar/extension-api'
import { createFakeAdapter } from '@kothar/core/fake'
import { startCore } from '@kothar/core/main'
import type { ClientMessage, CoreMessage, EngineEvent } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import { until } from '@kothar/core/test-wait'
import { afterEach, describe, expect, it } from 'vitest'
import home from '../home/index.ts'
import { createDeepResearchExtension, PLAN_SCHEMA, WRITE_SCHEMA, type Outcome } from './index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const PAGE = '<title>Alphabet</title><p>Alpha is the first letter of the Greek alphabet.</p>'
const WORKER_REPLY = `<findings>${JSON.stringify({
  findings: [{ claim: 'Alpha comes first', quote: 'Alpha is the first letter of the Greek alphabet', url: 'https://a.test/', title: 'A' }],
})}</findings>`

// The fake engine: a research worker (its prompt says so) replies with findings; any other chat's turn replies Done,
// unless `hold` is set, when it runs until released, as a turn does while a tool runs.
type Hold = { on: boolean; release?: () => void; workers?: boolean; releaseWorkers: (() => void)[] }

function engine(hold: Hold) {
  const base = createFakeAdapter([], 0)
  const prompts: string[] = []
  const adapter: typeof base = {
    ...base,
    start(_machine, _options, emit: (event: EngineEvent) => void) {
      let active = false
      const finish = (text: string) => {
        if (!active) return
        active = false
        emit({ type: 'text.completed', text })
        emit({ type: 'turn.completed' })
      }
      return {
        prompt(text: string) {
          prompts.push(text)
          active = true
          emit({ type: 'turn.started' })
          if (text.includes("Kothar's Deep Research")) {
            if (hold.workers) return void hold.releaseWorkers.push(() => finish(WORKER_REPLY))
            return void setTimeout(() => finish(WORKER_REPLY), 5)
          }
          if (hold.on) hold.release = () => finish('Done')
          else setTimeout(() => finish('Done'), 5)
        },
        respond() {},
        answer() {},
        interrupt() {
          if (!active) return
          active = false
          emit({ type: 'turn.completed', error: 'Interrupted' })
        },
        close() {
          active = false
        },
      }
    },
  }
  return { adapter, prompts }
}

async function core(settings: Record<string, string | number | boolean> = {}, others: Extension[] = []) {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-deep-research-')))
  const env = { KOTHAR_ENGINE: 'fake', KOTHAR_GARAGE: garage, KOTHAR_WORK: join(garage, 'work'), KOTHAR_PORT: '0' }
  const hold: Hold = { on: false, releaseWorkers: [] }
  const { adapter, prompts } = engine(hold)
  let host: ExtensionHost | undefined
  let values: ExtensionValues = {}
  const extension: Extension = createDeepResearchExtension({
    complete: async (_host, request) => {
      if (request.schema === PLAN_SCHEMA) return JSON.stringify({ subQuestions: ['Which letter is first?', 'Which is second?'], sources: ['encyclopedias'] })
      if (request.schema === WRITE_SCHEMA) {
        return JSON.stringify({ summary: [{ text: 'Alpha is first', cites: ['F1'] }], sections: [{ heading: 'Order', points: [{ text: 'Alpha leads', cites: ['F1'] }] }], disagreements: [], confidence: { level: 'medium', why: 'One source' }, openQuestions: [] })
      }
      return JSON.stringify({ gaps: [], contradictions: [] })
    },
    fetchPage: async (url) => {
      if (url !== 'https://a.test/') throw new Error('HTTP 404')
      return { body: PAGE, contentType: 'text/html' }
    },
  })
  const onStart = extension.onStart!
  extension.onStart = (context) => {
    host = context.host
    values = context.values
    return onStart(context)
  }
  const kothar = await startCore({ env, adapters: [adapter], extensions: [extension, ...others], machine: sandboxingMachine })
  cleanups.push(async () => {
    await kothar.close(true)
    rmSync(garage, { recursive: true, force: true })
  })
  const messages: CoreMessage[] = []
  kothar.core.onMessage((m) => messages.push(m))
  const handle = (m: ClientMessage) => kothar.core.handle(m, (r) => messages.push(r)) as unknown as Promise<void> | undefined
  handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
  handle({ type: 'workFolder.set', path: join(garage, 'work') })
  for (const [key, value] of Object.entries(settings)) handle({ type: 'extension.setValue', extensionId: 'deep-research', key, value })
  await until(() => host !== undefined)
  const chats = () => kothar.core.chats()
  const chat = (id: string) => chats().find((c) => c.id === id)!
  const create = (name = 'Space') => {
    handle({ type: 'chat.create', name })
    return chats().findLast((c) => c.name === name)!.id
  }
  const send = async (chatId: string, text: string) => {
    handle({ type: 'chat.send', chatId, text })
    await until(() => chat(chatId).status === 'idle' && !chat(chatId).queue.length)
  }
  const toggles = (chatId: string) => {
    handle({ type: 'context.get', chatId })
    const listed = messages.findLast((m) => m.type === 'chat.extensions' && m.chatId === chatId)
    return listed?.type === 'chat.extensions' ? listed.toggles : undefined
  }
  const flip = (chatId: string, on: boolean) => handle({ type: 'extension.toggle', chatId, extension: 'deep-research', toggle: 'research', on })
  // The deep_research tool, as the Kothar MCP server runs it for the chat's agent.
  const callTool = (chatId: string, question: string) => {
    const tool = extension.tools!.find((t) => t.name === 'deep_research')!
    const caller: ChatSummary = { id: chatId, name: chat(chatId).name, engine: 'fake' }
    return tool.run({ question }, { caller, values: { ...values, ...settings }, host: host! }) as Promise<Outcome>
  }
  return { garage, messages, handle, chats, chat, create, send, toggles, flip, callTool, prompts, hold, extension, host: () => host! }
}

describe('the Deep research toggle', () => {
  it('sits in each chat’s composer, off, and keeps each chat’s state apart', async () => {
    const t = await core()
    const a = t.create('A')
    const b = t.create('B')
    expect(t.toggles(a)).toEqual([expect.objectContaining({ extension: 'deep-research', id: 'research', label: 'Deep research', icon: 'search', on: false })])
    await t.flip(a, true)
    expect(t.toggles(a)).toMatchObject([{ on: true }])
    expect(t.toggles(b)).toMatchObject([{ on: false }])
    expect(t.chat(a).toggles).toEqual({ 'deep-research': { research: true } })
    expect(t.chat(b).toggles).toBeUndefined()
  })

  it('turns each message sent while on into a deep_research request, and leaves it alone when off', async () => {
    const t = await core()
    const on = t.create('On')
    const off = t.create('Off')
    await t.flip(on, true)
    await t.send(on, 'Which Greek letter comes first?')
    await t.send(off, 'Which Greek letter comes second?')
    const researched = t.prompts.filter((p) => p.includes('Call the deep_research tool'))
    expect(researched).toHaveLength(1)
    expect(researched[0]).toContain('Which Greek letter comes first?')
    // It stays on for the next message, until turned off.
    await t.send(on, 'And which comes last?')
    expect(t.prompts.filter((p) => p.includes('Call the deep_research tool'))).toHaveLength(2)
    await t.flip(on, false)
    await t.send(on, 'Thanks')
    expect(t.prompts.filter((p) => p.includes('Call the deep_research tool'))).toHaveLength(2)
    // The log keeps what the user typed.
    expect(t.chat(on).entries.filter((e) => e.type === 'user.message').map((e) => (e as { text: string }).text)).toContain('Which Greek letter comes first?')
  })

  // Home is the Home extension's own chat (chat.extension is 'home'), but it's still a chat the user types in.
  it('sits in Home’s composer too, and researches from there', async () => {
    const t = await core({ askFirst: false, depth: 'quick' }, [home])
    await until(() => t.chats().some((c) => c.extension === 'home'))
    const main = t.chats().find((c) => c.extension === 'home')!.id
    expect(t.toggles(main)).toEqual([expect.objectContaining({ extension: 'deep-research', id: 'research', label: 'Deep research', on: false })])
    // Its Research tab too, where Edit on the plan bar takes the plan.
    const listed = t.messages.findLast((m) => m.type === 'chat.extensions' && m.chatId === main)
    expect(listed?.type === 'chat.extensions' && listed.panels.map((p) => p.id)).toEqual(expect.arrayContaining(['research', 'report', 'new']))
    await t.flip(main, true)
    await t.send(main, 'Which Greek letter comes first?')
    expect(t.prompts.filter((p) => p.includes('Call the deep_research tool'))).toHaveLength(1)
    const outcome = await t.callTool(main, 'Greek letters?')
    expect(outcome).toMatchObject({ status: 'done', sources: 1 })
    await until(() => !t.chats().some((c) => c.parentId === main))
  })

  it('goes from the composer when the extension is turned off', async () => {
    const t = await core()
    const id = t.create()
    await t.flip(id, true)
    t.handle({ type: 'extension.setEnabled', extensionId: 'deep-research', enabled: false })
    expect(t.toggles(id)).toBeUndefined()
    await t.send(id, 'Which Greek letter comes first?')
    expect(t.prompts.some((p) => p.includes('Call the deep_research tool'))).toBe(false)
  })
})

describe('the deep_research tool', () => {
  it('researches with quiet workers under the space and saves a cited report, without waking the space', async () => {
    const t = await core({ askFirst: false, depth: 'quick' })
    const space = t.create()
    const outcome = await t.callTool(space, 'Greek letters?')
    expect(outcome).toMatchObject({ status: 'done', sources: 1, summary: 'Alpha is first [1]', report: { kind: 'file' } })
    const report = readFileSync(outcome.report!.ref, 'utf8')
    expect(report).toContain('- Alpha leads [1]')
    expect(report).toContain('1. [Alphabet](https://a.test/)')
    // The workers asked each sub-question, reported to the extension and went.
    expect(t.prompts.filter((p) => p.includes("Kothar's Deep Research"))).toHaveLength(2)
    await until(() => !t.chats().some((c) => c.parentId === space))
    expect(t.chat(space).entries.some((e) => e.type === 'worker.report')).toBe(false)
    expect(t.chat(space).queue).toEqual([])
    // A card in the chat, and the run's evidence kept.
    expect(t.chat(space).entries.findLast((e) => e.type === 'extension.note')).toMatchObject({ card: { badge: 'Research', detail: '1 source' } })
    expect(existsSync(join(t.garage, 'extensions', 'deep-research', 'runs', space))).toBe(true)
  })

  it('shows its workers as subagents with the setting on: each report folds in the chat, without waking it', async () => {
    const t = await core({ askFirst: false, depth: 'quick', showWorkers: true })
    const space = t.create()
    const outcome = await t.callTool(space, 'Greek letters?')
    expect(outcome).toMatchObject({ status: 'done', sources: 1 })
    await until(() => !t.chats().some((c) => c.parentId === space))
    const reports = t.chat(space).entries.filter((e) => e.type === 'worker.report')
    expect(reports).toHaveLength(2)
    expect(reports[0]).toMatchObject({ quiet: true, text: expect.stringContaining('<findings>') })
    // Logged for the user only: nothing queued, no turn of the space's agent.
    expect(t.chat(space).queue).toEqual([])
    expect(t.chat(space).entries.some((e) => e.type === 'turn.started')).toBe(false)
    expect(t.chat(space).status).toBe('idle')
  })

  it('shows its workers as subagents in Home too', async () => {
    const t = await core({ askFirst: false, depth: 'quick', showWorkers: true }, [home])
    await until(() => t.chats().some((c) => c.extension === 'home'))
    const main = t.chats().find((c) => c.extension === 'home')!.id
    expect(await t.callTool(main, 'Greek letters?')).toMatchObject({ status: 'done', sources: 1 })
    await until(() => !t.chats().some((c) => c.parentId === main))
    const reports = t.chat(main).entries.filter((e) => e.type === 'worker.report')
    expect(reports).toHaveLength(2)
    expect(reports.every((e) => (e as { quiet?: true }).quiet === true)).toBe(true)
    expect(t.chat(main).queue).toEqual([])
    expect(t.chat(main).status).toBe('idle')
  })

  it('keeps its workers quiet with the setting on while Workers is off, and greys the setting out', async () => {
    const t = await core({ askFirst: false, depth: 'quick', showWorkers: true })
    t.handle({ type: 'extension.setEnabled', extensionId: 'workers', enabled: false })
    const listed = t.messages.findLast((m) => m.type === 'extension.updated' && m.extension.id === 'deep-research')
    expect(listed).toMatchObject({ extension: { blockedSettings: { showWorkers: 'Needs the Workers extension' }, values: { showWorkers: false } } })
    const space = t.create()
    expect(await t.callTool(space, 'Greek letters?')).toMatchObject({ status: 'done', sources: 1 })
    await until(() => !t.chats().some((c) => c.parentId === space))
    expect(t.chat(space).entries.some((e) => e.type === 'worker.report')).toBe(false)
  })

  it('carries on when Workers is turned off mid-run: workers already shown stay so, the rest are quiet', async () => {
    const t = await core({ askFirst: false, depth: 'quick', showWorkers: true })
    const space = t.create()
    t.hold.workers = true
    const done = t.callTool(space, 'Greek letters?')
    await until(() => t.hold.releaseWorkers.length === 2)
    t.handle({ type: 'extension.setEnabled', extensionId: 'workers', enabled: false })
    for (const release of t.hold.releaseWorkers.splice(0)) release()
    expect(await done).toMatchObject({ status: 'done', sources: 1 })
    await until(() => !t.chats().some((c) => c.parentId === space))
    expect(t.chat(space).entries.filter((e) => e.type === 'worker.report')).toHaveLength(2)
    // The next run's workers are quiet.
    t.hold.workers = false
    expect(await t.callTool(space, 'Greek letters again?')).toMatchObject({ status: 'done' })
    await until(() => !t.chats().some((c) => c.parentId === space))
    expect(t.chat(space).entries.filter((e) => e.type === 'worker.report')).toHaveLength(2)
  })

  it('shows the plan on the chat’s bar while its turn runs, and Start goes on', async () => {
    const t = await core({ depth: 'quick' })
    const space = t.create()
    t.hold.on = true
    t.handle({ type: 'chat.send', chatId: space, text: 'Research Greek letters' })
    await until(() => t.chat(space).status === 'running')
    const done = t.callTool(space, 'Greek letters?')
    await until(() => (t.chat(space).waits ?? []).length > 0)
    expect(t.chat(space).waits).toMatchObject([{ extension: 'deep-research', text: expect.stringContaining('2 sub-questions'), buttons: [{ id: 'start' }, { id: 'edit' }, { id: 'cancel' }] }])
    expect(t.prompts.some((p) => p.includes("Kothar's Deep Research"))).toBe(false)
    await t.handle({ type: 'extension.wait.answer', chatId: space, extension: 'deep-research', button: 'start' })
    expect(t.chat(space).waits ?? []).toEqual([])
    expect(await done).toMatchObject({ status: 'done' })
    t.hold.release?.()
  })

  it('does nothing on Cancel', async () => {
    const t = await core({ depth: 'quick' })
    const space = t.create()
    t.hold.on = true
    t.handle({ type: 'chat.send', chatId: space, text: 'Research Greek letters' })
    await until(() => t.chat(space).status === 'running')
    const done = t.callTool(space, 'Greek letters?')
    await until(() => (t.chat(space).waits ?? []).length > 0)
    await t.handle({ type: 'extension.wait.answer', chatId: space, extension: 'deep-research', button: 'cancel' })
    expect(await done).toMatchObject({ status: 'cancelled' })
    expect(t.prompts.some((p) => p.includes("Kothar's Deep Research"))).toBe(false)
    t.hold.release?.()
  })

  it('isn’t offered to its own workers, which show under the space while they run', async () => {
    const t = await core({ askFirst: false, depth: 'quick' })
    const space = t.create()
    t.hold.workers = true
    const done = t.callTool(space, 'Greek letters?')
    await until(() => t.hold.releaseWorkers.length === 2)
    const workers = t.chats().filter((c) => c.parentId === space)
    expect(workers.map((w) => w.name)).toEqual(['Research: Which letter is first?', 'Research: Which is second?'])
    const tool = t.extension.tools![0]!
    expect(tool.offered({ id: space, name: 'Space', engine: 'fake' })).toBe(true)
    expect(workers.map((w) => tool.offered({ id: w.id, name: w.name, engine: 'fake', parentId: space, worker: true }))).toEqual([false, false])
    for (const release of t.hold.releaseWorkers) release()
    await done
  })

  it('stops its workers and writes a partial report when stopped from the Research tab', async () => {
    const t = await core({ askFirst: false, depth: 'quick' })
    const space = t.create()
    t.hold.workers = true
    const done = t.callTool(space, 'Greek letters?')
    await until(() => t.hold.releaseWorkers.length === 2)
    const runId = readRunId(t.garage, space)
    await t.handle({ type: 'extension.panel.action', chatId: space, extension: 'deep-research', panel: 'research', action: { name: 'stop', value: runId } })
    const outcome = await done
    expect(outcome.status).toBe('partial')
    expect(readFileSync(outcome.report!.ref, 'utf8')).toContain('**Partial report.** You stopped it.')
    await until(() => !t.chats().some((c) => c.parentId === space))
  })
})

function readRunId(garage: string, space: string): string {
  const dir = join(garage, 'extensions', 'deep-research', 'runs', space)
  return readdirSync(dir).find((name) => name.endsWith('.json'))!.slice(0, -'.json'.length)
}

describe('a deleted space', () => {
  it('takes its research with it', async () => {
    const t = await core({ askFirst: false, depth: 'quick' })
    const space = t.create()
    const other = t.create('Other')
    await t.callTool(space, 'Greek letters?')
    await t.callTool(other, 'Greek letters?')
    const runs = join(t.garage, 'extensions', 'deep-research', 'runs')
    expect(existsSync(join(runs, space))).toBe(true)
    await until(() => !t.chats().some((c) => c.parentId === space) && t.chat(space).status === 'idle')
    t.handle({ type: 'chat.delete', chatId: space })
    await until(() => !existsSync(join(runs, space)))
    expect(existsSync(join(runs, other))).toBe(true)
  })
})

describe('New research and the Research tab', () => {
  const panelView = (t: Awaited<ReturnType<typeof core>>, chatId: string, panel: string) => {
    const drawn = t.messages.findLast((m) => m.type === 'extension.panel' && m.chatId === chatId && m.panel === panel)
    return drawn?.type === 'extension.panel' ? JSON.stringify(drawn.view ?? drawn.error) : ''
  }

  it('starts from the popup in the background; the plan waits in the tab, and Start there runs it', async () => {
    const t = await core()
    const space = t.create()
    t.handle({ type: 'context.get', chatId: space })
    const listed = t.messages.findLast((m) => m.type === 'chat.extensions' && m.chatId === space)
    expect(listed).toMatchObject({
      panels: expect.arrayContaining([
        expect.objectContaining({ extension: 'deep-research', id: 'new', placement: 'popup', launcher: true, shortcut: 'Mod+Shift+D' }),
        expect.objectContaining({ id: 'research', title: 'Research' }),
        expect.objectContaining({ id: 'report', placement: 'dock' }),
      ]),
    })
    await t.handle({ type: 'extension.panel.get', chatId: space, extension: 'deep-research', panel: 'new' })
    await t.handle({ type: 'extension.panel.action', chatId: space, extension: 'deep-research', panel: 'new', action: { name: 'depth', value: 'quick' } })
    await until(() => panelView(t, space, 'new').includes('"label":"Quick","variant":"primary"'))
    await t.handle({ type: 'extension.panel.action', chatId: space, extension: 'deep-research', panel: 'new', action: { name: 'start-new', value: { question: 'Greek letters?' } } })
    expect(t.messages).toContainEqual(expect.objectContaining({ type: 'extension.panel.close', chatId: space, panel: 'new' }))
    expect(t.messages).toContainEqual(expect.objectContaining({ type: 'extension.panel.show', chatId: space, panel: 'research' }))
    await t.handle({ type: 'extension.panel.get', chatId: space, extension: 'deep-research', panel: 'research' })
    await until(() => panelView(t, space, 'research').includes('Plan waiting for you'))
    // No bar: nothing's running in the chat to hold it.
    expect(t.chat(space).waits ?? []).toEqual([])
    expect(panelView(t, space, 'research')).toContain('Which letter is first?')
    const runId = readRunId(t.garage, space)
    await t.handle({ type: 'extension.panel.action', chatId: space, extension: 'deep-research', panel: 'research', action: { name: 'start', value: runId } })
    await until(() => panelView(t, space, 'research').includes('Open report'))
    expect(panelView(t, space, 'research')).toContain('"text":"Done"')
    expect(t.prompts.filter((p) => p.includes("Kothar's Deep Research"))).toHaveLength(2)
  })

  it('edits the plan in the tab after Edit on the bar', async () => {
    const t = await core({ depth: 'quick' })
    const space = t.create()
    t.hold.on = true
    t.handle({ type: 'chat.send', chatId: space, text: 'Research Greek letters' })
    await until(() => t.chat(space).status === 'running')
    const done = t.callTool(space, 'Greek letters?')
    await until(() => (t.chat(space).waits ?? []).length > 0)
    await t.handle({ type: 'extension.panel.get', chatId: space, extension: 'deep-research', panel: 'research' })
    await t.handle({ type: 'extension.wait.answer', chatId: space, extension: 'deep-research', button: 'edit' })
    expect(t.chat(space).waits ?? []).toEqual([])
    await until(() => panelView(t, space, 'research').includes('Sub-questions, one per line'))
    await t.handle({ type: 'extension.panel.action', chatId: space, extension: 'deep-research', panel: 'research', action: { name: 'start-edited', value: { subs: '1. Only this one?' } } })
    expect(await done).toMatchObject({ status: 'done' })
    const asked = t.prompts.filter((p) => p.includes("Kothar's Deep Research"))
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('Your sub-question: Only this one?')
    t.hold.release?.()
  })

  it('opens a finished report in the dock with one click, shows its evidence, and deletes it', async () => {
    const t = await core({ askFirst: false, depth: 'quick' })
    const space = t.create()
    await t.callTool(space, 'Greek letters?')
    const runId = readRunId(t.garage, space)
    await t.handle({ type: 'extension.panel.get', chatId: space, extension: 'deep-research', panel: 'report' })
    await t.handle({ type: 'extension.panel.action', chatId: space, extension: 'deep-research', panel: 'research', action: { name: 'open', value: runId } })
    expect(t.messages).toContainEqual(expect.objectContaining({ type: 'extension.panel.show', chatId: space, panel: 'report', placement: 'dock' }))
    await until(() => panelView(t, space, 'report').includes('## Sources'))
    expect(panelView(t, space, 'report')).toContain('"type":"download"')
    await t.handle({ type: 'extension.panel.action', chatId: space, extension: 'deep-research', panel: 'research', action: { name: 'evidence', value: runId } })
    await until(() => panelView(t, space, 'report').includes('Findings'))
    expect(panelView(t, space, 'report')).toContain('Alpha is the first letter of the Greek alphabet')
    await t.handle({ type: 'extension.panel.action', chatId: space, extension: 'deep-research', panel: 'research', action: { name: 'delete', value: runId } })
    expect(existsSync(join(t.garage, 'extensions', 'deep-research', 'runs', space, `${runId}.json`))).toBe(false)
    await t.handle({ type: 'extension.panel.get', chatId: space, extension: 'deep-research', panel: 'research' })
    await until(() => panelView(t, space, 'research').includes('No research yet'))
  })
})
