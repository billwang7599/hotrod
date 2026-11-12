import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Extension, ExtensionHost, ExtensionView } from '@kothar/extension-api'
import { createFakeAdapter, type FakeStep } from '@kothar/core/fake'
import { startCore } from '@kothar/core/main'
import type { ClientMessage, CoreMessage, SessionOptions } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import { until } from '@kothar/core/test-wait'
import plan, { APPROVED_PROMPT, PLAN_FILE, createPlanExtension, parsePlan, planFrom, planMarkdown, READ_ONLY_REASON } from './index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ask = (toolId: string, kind: 'edit' | 'shell', detail: { path?: string; command?: string }): FakeStep[] => {
  const call = { toolId, name: kind === 'edit' ? 'Edit' : 'Bash', kind, summary: detail.path ?? detail.command ?? '', input: detail }
  return [{ type: 'tool.started', ...call }, { type: 'permission', ...call, ...detail, output: 'ok' }]
}
// A turn that edits a file in the work folder, runs a command that writes, and one that only reads.
const TRIES: FakeStep[] = [
  ...ask('e1', 'edit', { path: 'src/app.ts' }),
  ...ask('s1', 'shell', { command: 'npm install left-pad' }),
  ...ask('s2', 'shell', { command: 'git log --oneline' }),
  { type: 'text.completed', text: 'Done' },
]
const REPLY: FakeStep[] = [{ type: 'text.completed', text: 'Done' }]

const PLAN = {
  goal: 'Add a dark mode switch to Settings',
  files: ['src/settings.tsx', 'src/theme.ts'],
  steps: ['Add a theme setting', 'Draw the switch', 'Apply the theme on load'],
  risks: ['Flash of the light theme on start'],
  tests: 'Add a settings test; check by hand in both themes.',
}

type Agent = (chatId: string, host: ExtensionHost) => Promise<unknown> | void

// Kothar on two fake engines (alpha; beta for the Planning list) with the Plan extension. Each session first runs
// `agent` (standing in for the agent's tool calls), then plays `steps`. Every session's options and prompt are kept.
async function start(options: { extensions?: Extension[]; steps?: FakeStep[] } = {}) {
  let host: ExtensionHost | undefined
  const helper: Extension = { id: 'helper', name: 'Helper', description: '', enabledByDefault: true }
  helper.onChatCreated = (_chat, context) => void (host = context.host)
  helper.onStart = (context) => void (host = context.host)
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-plan-')))
  const env = { KOTHAR_ENGINE: 'alpha', KOTHAR_GARAGE: garage, KOTHAR_WORK: join(garage, 'work'), KOTHAR_PORT: '0' }
  const sessions: { engine: string; chatId: string; options: SessionOptions; prompt: string }[] = []
  const agents: Agent[] = []
  let steps = options.steps ?? REPLY
  const engine = (id: string) => {
    const base = { ...createFakeAdapter(() => steps, 0), id }
    const adapter: typeof base = {
      ...base,
      start(machine, sessionOptions, emit) {
        const session = base.start(machine, sessionOptions, emit)
        // The chat a session belongs to: the one whose work folder it runs in, else the only running one.
        return {
          ...session,
          prompt: (text, images) => {
            const running = core.chats().filter((c) => c.status === 'running')
            const chatId = running.at(-1)?.id ?? ''
            sessions.push({ engine: id, chatId, options: sessionOptions, prompt: text })
            const agent = agents.shift()
            void Promise.resolve(agent?.(chatId, host!)).finally(() => session.prompt(text, images))
          },
        }
      },
    }
    return adapter
  }
  const extension = createPlanExtension()
  const kothar = await startCore({
    env,
    adapters: [engine('alpha'), engine('beta')],
    extensions: [extension, helper, ...(options.extensions ?? [])],
    machine: sandboxingMachine,
  })
  cleanups.push(async () => {
    await kothar.close(true)
    rmSync(garage, { recursive: true, force: true })
  })
  const { core } = kothar
  const replies: CoreMessage[] = []
  const handle = (message: ClientMessage) => core.handle(message, (r) => replies.push(r))
  core.onMessage((m) => replies.push(m))
  handle({ type: 'engine.setEnabled', engine: 'beta', enabled: true })
  const create = (name: string) => {
    handle({ type: 'chat.create', name })
    return core.chats().findLast((c) => c.name === name)!.id
  }
  const chatOf = (id: string) => core.chats().find((c) => c.id === id)!
  const settled = (id: string) => until(() => chatOf(id)?.status === 'idle' && !chatOf(id)!.queue.length)
  const waiting = (id: string) => until(() => chatOf(id)?.status === 'waiting' && (chatOf(id)!.waits?.length ?? 0) > 0)
  const send = (id: string, text = 'Add dark mode', agent?: Agent) => {
    if (agent) agents.push(agent)
    handle({ type: 'chat.send', chatId: id, text })
  }
  const flip = (id: string, on: boolean) => handle({ type: 'extension.toggle', chatId: id, extension: 'plan', toggle: 'plan', on })
  const toggles = (id: string) => {
    handle({ type: 'context.get', chatId: id })
    const found = replies.findLast((m) => m.type === 'chat.extensions' && m.chatId === id)
    return found?.type === 'chat.extensions' ? (found.toggles ?? []) : undefined
  }
  const isOn = (id: string) => toggles(id)?.find((t) => t.extension === 'plan')?.on
  const answer = (id: string, button: string) => handle({ type: 'extension.wait.answer', chatId: id, extension: 'plan', button } as ClientMessage)
  const panel = async (id: string): Promise<ExtensionView | undefined> => {
    const before = replies.length
    await handle({ type: 'extension.panel.get', chatId: id, extension: 'plan', panel: 'plan' })
    await until(() => replies.slice(before).some((m) => m.type === 'extension.panel' && m.chatId === id))
    const found = replies.slice(before).findLast((m) => m.type === 'extension.panel' && m.chatId === id)
    return found?.type === 'extension.panel' ? found.view : undefined
  }
  const panelAction = (id: string, action: { name: string; value?: unknown }) =>
    handle({ type: 'extension.panel.action', chatId: id, extension: 'plan', panel: 'plan', action } as ClientMessage)
  const resolved = (id: string) => chatOf(id).entries.flatMap((e) => (e.type === 'permission.resolved' ? [e.allow] : []))
  const stored = (id: string) => parsePlan(host!.chatStorage(id).read(PLAN_FILE))
  const submit = (input: Record<string, unknown> = PLAN): Agent => (chatId, h) => h.callTool(chatId, 'submit_plan', input)
  return {
    core, garage, handle, create, chatOf, settled, waiting, send, flip, toggles, isOn, answer, panel, panelAction,
    resolved, stored, submit, sessions, extension, host: () => host!,
    // An agent for the next session the test doesn't send itself (an approval's continuation, a worker's turn).
    queueAgent: (agent: Agent) => void agents.push(agent),
    setSteps: (next: FakeStep[]) => void (steps = next),
  }
}

// Every piece of text in a view, in order, for checking what a panel shows.
const textOf = (view: unknown): string =>
  typeof view === 'string' ? view : Array.isArray(view) ? view.map(textOf).join(' ') : view && typeof view === 'object' ? Object.values(view).map(textOf).join(' ') : ''

describe('Plan', () => {
  it('is on by default, with its two settings', () => {
    expect(plan.enabledByDefault).toBe(true)
    expect(plan.settings?.map((s) => [s.key, s.type === 'boolean' && s.default])).toEqual([['showToggle', true], ['requireTests', true]])
  })

  it('keeps Plan first per chat, off to begin with, without leaking to other chats', async () => {
    const t = await start()
    const a = t.create('A')
    const b = t.create('B')
    expect(t.isOn(a)).toBe(false)
    t.flip(a, true)
    expect(t.isOn(a)).toBe(true)
    expect(t.isOn(b)).toBe(false)
    t.send(b)
    await t.settled(b)
    expect(t.sessions.at(-1)!.options.readOnly).toBeUndefined()
  })

  it('makes a Plan first turn read only: edits and changing commands refused, reads allowed, nothing writable', async () => {
    const t = await start({ steps: TRIES })
    const id = t.create('Space')
    t.flip(id, true)
    t.send(id)
    await t.settled(id)
    expect(t.resolved(id)).toEqual([false, false, true])
    const outputs = t.chatOf(id).entries.flatMap((e) => (e.type === 'tool.completed' ? [e.output] : []))
    expect(outputs.slice(0, 2)).toEqual([READ_ONLY_REASON, READ_ONLY_REASON])
    const { options } = t.sessions.at(-1)!
    expect(options.readOnly).toBe(true)
    expect(options.sandbox?.writable).toEqual([])
    expect(options.instructions).toContain('Plan first is on')
  })

  it('stays read only even when another extension allows everything', async () => {
    const allowAll: Extension = { id: 'yes', name: 'Yes', description: '', enabledByDefault: true, onPermissionRequested: () => ({ allow: true }) }
    const t = await start({ steps: TRIES, extensions: [allowAll] })
    const id = t.create('Space')
    t.flip(id, true)
    t.send(id)
    await t.settled(id)
    expect(t.resolved(id)).toEqual([false, false, true])
  })

  it('plans on the Planning model list when it has models, and on the chat’s own otherwise', async () => {
    const t = await start()
    const id = t.create('Space')
    t.flip(id, true)
    t.send(id)
    await t.settled(id)
    expect(t.sessions.at(-1)!.engine).toBe('alpha')
    t.handle({ type: 'models.setList', role: 'planning', models: [{ engine: 'beta', model: 'fake-large' }] })
    t.send(id)
    await t.settled(id)
    expect(t.sessions.at(-1)).toMatchObject({ engine: 'beta', options: { model: 'fake-large' } })
    expect(t.chatOf(id).engine).toBe('alpha')
  })

  it('shows the plan on the amber bar once the turn that handed it in ends', async () => {
    const t = await start()
    const id = t.create('Space')
    t.flip(id, true)
    t.send(id, 'Add dark mode', t.submit())
    await t.waiting(id)
    const [wait] = t.chatOf(id).waits!
    expect(wait!.text).toContain('Add a dark mode switch to Settings')
    expect(wait!.buttons.map((b) => [b.label, !!b.closes])).toEqual([['Approve', true], ['Edit', false], ['Cancel', true]])
    expect(t.stored(id)).toMatchObject({ status: 'proposed', steps: [{ text: 'Add a theme setting', status: 'todo' }, {}, {}] })
  })

  it('Approve turns Plan first off and carries on with usual permissions and the plan in the instructions', async () => {
    const t = await start()
    const id = t.create('Space')
    t.flip(id, true)
    t.send(id, 'Add dark mode', t.submit())
    await t.waiting(id)
    const before = t.sessions.length
    t.answer(id, 'approve')
    await until(() => t.sessions.length > before)
    await t.settled(id)
    expect(t.isOn(id)).toBe(false)
    const session = t.sessions.at(-1)!
    expect(session.options.readOnly).toBeUndefined()
    expect(session.options.sandbox?.writable.length).toBeGreaterThan(0)
    expect(session.options.instructions).toContain('The user approved this plan')
    expect(session.options.instructions).toContain('1. [ ] Add a theme setting')
    expect(session.prompt).toContain(APPROVED_PROMPT)
    expect(t.stored(id)?.status).toBe('approved')
    expect(t.chatOf(id).waits ?? []).toEqual([])
  })

  it('Cancel drops the plan and keeps Plan first on', async () => {
    const t = await start()
    const id = t.create('Space')
    t.flip(id, true)
    t.send(id, 'Add dark mode', t.submit())
    await t.waiting(id)
    t.answer(id, 'cancel')
    await t.settled(id)
    expect(t.isOn(id)).toBe(true)
    expect(t.stored(id)?.status).toBe('cancelled')
    expect(t.chatOf(id).waits ?? []).toEqual([])
  })

  it('Edit opens the form in the Plan tab, and saving changes the stored plan and the bar', async () => {
    const t = await start()
    const id = t.create('Space')
    t.flip(id, true)
    t.send(id, 'Add dark mode', t.submit())
    await t.waiting(id)
    t.answer(id, 'edit')
    expect(JSON.stringify(await t.panel(id))).toContain('"type":"form"')
    const value = { goal: 'Dark mode, toggled in Settings', steps: 'Add a theme setting\nDraw the switch', files: 'src/settings.tsx', risks: '', tests: 'A settings test' }
    await t.panelAction(id, { name: 'save', value })
    await until(() => t.stored(id)?.goal === value.goal)
    expect(t.stored(id)).toMatchObject({ status: 'proposed', steps: [{ text: 'Add a theme setting' }, { text: 'Draw the switch' }], files: ['src/settings.tsx'], risks: [] })
    expect(t.chatOf(id).waits![0]!.text).toContain('Dark mode, toggled in Settings (2 steps)')
    expect(JSON.stringify(await t.panel(id))).not.toContain('"type":"form"')
  })

  it('turns away a plan without a tests step, unless that setting is off', async () => {
    const t = await start()
    const id = t.create('Space')
    t.flip(id, true)
    let error = ''
    t.send(id, 'Go', (chatId, h) => h.callTool(chatId, 'submit_plan', { ...PLAN, tests: '' }).catch((e: Error) => void (error = e.message)))
    await t.settled(id)
    expect(error).toContain('tests step')
    expect(t.stored(id)).toBeUndefined()
    t.handle({ type: 'extension.setValue', extensionId: 'plan', key: 'requireTests', value: false })
    t.send(id, 'Go', t.submit({ ...PLAN, tests: '' }))
    await t.waiting(id)
    expect(t.stored(id)?.tests).toBe('')
  })

  it('ticks steps with update_plan_step, and the tab shows progress', async () => {
    const t = await start()
    const id = t.create('Space')
    t.flip(id, true)
    t.send(id, 'Add dark mode', t.submit())
    await t.waiting(id)
    const before = t.sessions.length
    // The approved turn ticks two steps.
    const tick: Agent = async (chatId, h) => {
      await h.callTool(chatId, 'update_plan_step', { step: 1, status: 'done', note: 'Added theme to settings.json' })
      await h.callTool(chatId, 'update_plan_step', { step: 3, status: 'skipped', note: 'Already applied at load' })
    }
    t.queueAgent(tick)
    t.answer(id, 'approve')
    await until(() => t.sessions.length > before)
    await t.settled(id)
    expect(t.stored(id)!.steps.map((s) => s.status)).toEqual(['done', 'todo', 'skipped'])
    const shown = textOf(await t.panel(id))
    expect(shown).toContain('2 of 3 done')
    expect(shown).toContain('Added theme to settings.json')
    expect(shown).toContain('Skipped')
  })

  it('read_plan gives the plan back in a later session, after the conversation was summarised away', async () => {
    const t = await start()
    const id = t.create('Space')
    t.flip(id, true)
    t.send(id, 'Add dark mode', t.submit())
    await t.waiting(id)
    t.answer(id, 'approve')
    await t.settled(id)
    let read = ''
    t.send(id, 'Where were we?', async (chatId, h) => void (read = String(await h.callTool(chatId, 'read_plan', {}))))
    await t.settled(id)
    expect(read).toBe(planMarkdown(t.stored(id)!))
    expect(read).toContain('# Plan: Add a dark mode switch to Settings')
  })

  it('gives a worker its lead’s approved plan, and lets it tick the lead’s steps', async () => {
    const t = await start()
    const id = t.create('Space')
    t.flip(id, true)
    t.send(id, 'Add dark mode', t.submit())
    await t.waiting(id)
    t.answer(id, 'approve')
    await t.settled(id)
    const worker = t.host().createChat({ name: 'Step 2', parentId: id })
    t.host().send(worker.id, 'Do step 2')
    t.queueAgent((chatId, h) => h.callTool(chatId, 'update_plan_step', { step: 2, status: 'done' }))
    await until(() => t.stored(id)!.steps[1]!.status === 'done')
    const session = t.sessions.find((s) => s.prompt.includes('Do step 2'))
    expect(session?.options.instructions).toContain('Your lead is working through this approved plan')
  })

  it('without Show Plan first toggle, the chip goes; turned off, the chip and tools go', async () => {
    const t = await start()
    const id = t.create('Space')
    expect(t.toggles(id)?.some((x) => x.extension === 'plan')).toBe(true)
    t.handle({ type: 'extension.setValue', extensionId: 'plan', key: 'showToggle', value: false })
    expect(t.toggles(id)?.some((x) => x.extension === 'plan')).toBe(false)
    t.handle({ type: 'extension.setValue', extensionId: 'plan', key: 'showToggle', value: true })
    t.handle({ type: 'extension.setEnabled', extensionId: 'plan', enabled: false })
    expect(t.toggles(id)?.some((x) => x.extension === 'plan')).toBe(false)
    await expect(t.host().callTool(id, 'read_plan', {})).rejects.toThrow()
  })

  it('removes the plan with its chat', async () => {
    const t = await start()
    const id = t.create('Space')
    t.flip(id, true)
    t.send(id, 'Add dark mode', t.submit())
    await t.waiting(id)
    t.answer(id, 'cancel')
    await t.settled(id)
    const file = join(t.host().chatStorage(id).dir, PLAN_FILE)
    expect(existsSync(file)).toBe(true)
    t.handle({ type: 'chat.delete', chatId: id })
    await until(() => !existsSync(file))
  })
})

describe('planFrom', () => {
  const now = new Date('2026-11-12T10:00:00Z')
  it('needs a goal and steps, and cleans list marks off lines', () => {
    expect(planFrom({ steps: ['a'], tests: 'x' }, { requireTests: true, now })).toEqual({ error: expect.stringContaining('goal') })
    expect(planFrom({ goal: 'g', steps: [], tests: 'x' }, { requireTests: true, now })).toEqual({ error: expect.stringContaining('step') })
    const made = planFrom({ goal: 'g', steps: '1. one\n- two\n\n[ ] three', tests: 'x' }, { requireTests: true, now })
    expect('error' in made ? [] : made.steps.map((s) => s.text)).toEqual(['one', 'two', 'three'])
  })

  it('keeps the ticks of steps it keeps when edited', () => {
    const before = planFrom({ goal: 'g', steps: ['one', 'two'], tests: 'x' }, { requireTests: true, now })
    if ('error' in before) throw new Error(before.error)
    before.steps[0] = { text: 'one', status: 'done', note: 'ok' }
    const after = planFrom({ goal: 'g', steps: 'zero\none', tests: 'x' }, { requireTests: true, now, before })
    expect('error' in after ? [] : after.steps).toEqual([{ text: 'zero', status: 'todo' }, { text: 'one', status: 'done', note: 'ok' }])
  })
})
