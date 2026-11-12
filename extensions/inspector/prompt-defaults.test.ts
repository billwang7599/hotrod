// Moving the built-in extensions' hidden text onto named prompts must not change a byte of what agents are sent.
// prompt-defaults.golden.json holds that text as the extensions sent it before the move (captured from their source
// then); every prompt's default, and what each hook sends with no edits, must match it exactly.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChatSummary, Extension, ExtensionContext, ExtensionHost } from '@kothar/extension-api'
import { instructionsFor, MAKE } from '../artifacts/index.ts'
import { CHIP_TEXT } from '../deep-research/index.ts'
import { TEXT, workerPrompt } from '../deep-research/run.ts'
import { createPlanExtension } from '../plan/index.ts'
import { INDEX_INTRO, skillIndex } from '../skills/index.ts'

const golden = JSON.parse(readFileSync(new URL('./prompt-defaults.golden.json', import.meta.url), 'utf8')) as Record<string, string>

const dirs = readdirSync(new URL('..', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
  .map((entry) => entry.name)
const builtIns = await Promise.all(
  dirs.map(async (dir) => (await import(/* @vite-ignore */ new URL(`../${dir}/index.ts`, import.meta.url).href)).default as Extension),
)
const byId = (id: string) => builtIns.find((extension) => extension.id === id)!
const promptText = (id: string, prompt: string) => {
  const found = byId(id).prompts?.find((p) => p.id === prompt)
  if (!found) throw new Error(`${id} has no prompt ${prompt}`)
  return found.text
}

// A host that hands back each prompt's default, as the core does with no edits; it records what was asked.
const hostFor = (extension: Extension, more: Partial<ExtensionHost> = {}) => {
  const asked: string[] = []
  const host = {
    prompt(id: string) {
      asked.push(id)
      const found = extension.prompts?.find((p) => p.id === id)
      if (!found) throw new Error(`${extension.name} has no prompt "${id}"`)
      return found.text
    },
    ...more,
  } as unknown as ExtensionHost
  return { host, asked }
}
const context = (host: ExtensionHost, values: Record<string, unknown> = {}) => ({ host, values }) as unknown as ExtensionContext
const chat = (worker = false) => ({ id: 'c1', name: 'c', ...(worker && { worker: { parentId: 'p' } }) }) as unknown as ChatSummary

describe('every built-in prompt default is the text it replaced, byte for byte', () => {
  const cases: [string, string, string][] = [
    ['artifacts', 'only-when-asked', 'artifacts:asked'],
    ['artifacts', 'when-useful', 'artifacts:useful'],
    ['browser', 'browser', 'browser:browser'],
    ['browser', 'your-chrome', 'browser:your-chrome'],
    ['processes', 'instructions', 'processes:instructions'],
    ['memory', 'tree', 'memory:tree'],
    ['memory', 'tree-zoom', 'memory:tree-zoom'],
    ['memory', 'rolling', 'memory:rolling'],
    ['memory', 'rolling-zoom', 'memory:rolling-zoom'],
    ['memory', 'parent-zoom', 'memory:parent-zoom'],
    ['memory', 'summarizer-tree', 'memory:compactor'],
    ['memory', 'summarizer-rolling', 'memory:fold'],
    ['plan', 'planning', 'plan:planning:true'],
    ['plan', 'planning-worker', 'plan:planning-worker'],
    ['plan', 'approved', 'plan:approved'],
    ['plan', 'approved-worker', 'plan:approved-worker'],
    ['plan', 'steps', 'plan:approved-steps'],
    ['plan', 'approved-message', 'plan:approved-message'],
    ['plan', 'read-only-reason', 'plan:read-only-reason'],
    ['deep-research', 'chip', 'research:chip'],
    ['deep-research', 'planner', 'research:plan'],
    ['deep-research', 'reviewer', 'research:review'],
    ['deep-research', 'writer', 'research:write'],
    ['reconnect', 'continue', 'reconnect:continue'],
    ['account-rotation', 'continue', 'account-rotation:continue'],
    ['home', 'role', 'home:role'],
  ]
  it.each(cases)('%s: %s', (id, prompt, key) => {
    expect(golden[key]).toBeTypeOf('string')
    expect(promptText(id, prompt)).toBe(golden[key])
  })

  it('every golden text is checked', () => {
    const checked = new Set([
      ...cases.map(([, , key]) => key),
      'skills:index',
      'plan:planning:false',
      'research:worker',
    ])
    expect(Object.keys(golden).filter((key) => !checked.has(key))).toEqual([])
  })
})

describe('what the hooks send with no edits is unchanged', () => {
  it('Artifacts: each Make artifacts choice, through host.prompt', () => {
    const { host, asked } = hostFor(byId('artifacts'))
    expect(instructionsFor(MAKE.asked, host)).toBe(golden['artifacts:asked'])
    expect(instructionsFor(MAKE.useful, host)).toBe(golden['artifacts:useful'])
    expect(instructionsFor(undefined)).toBe(golden['artifacts:asked'])
    expect(asked).toEqual(['only-when-asked', 'when-useful'])
  })

  it('Browser: its instructions, and with your own Chrome', () => {
    const browser = byId('browser')
    const { host } = hostFor(browser)
    expect(browser.instructions!({ chat: chat(), tools: true } as never, context(host))).toBe(golden['browser:browser'])
    expect(browser.instructions!({ chat: chat(), tools: false } as never, context(host))).toBeUndefined()
  })

  it('Processes', () => {
    const processes = byId('processes')
    const { host, asked } = hostFor(processes)
    expect(processes.instructions!({ chat: chat(), tools: true } as never, context(host))).toBe(golden['processes:instructions'])
    expect(asked).toEqual(['instructions'])
  })

  it('Skills: the intro before the list', () => {
    expect(promptText('skills', 'index')).toBe(INDEX_INTRO)
    const skills = [{ id: 'a', description: 'Does a', on: true }, { id: 'b', description: 'Does b', on: true }] as never
    expect(skillIndex(skills)).toBe(golden['skills:index'])
    expect(skillIndex(skills, promptText('skills', 'index'))).toBe(golden['skills:index'])
  })

  it('Memory: each mode, with and without tools, and a worker', () => {
    const memory = byId('memory')
    const { host } = hostFor(memory)
    const send = (mode: string, tools: boolean, worker = false) =>
      memory.memory!.instructions!({ chat: chat(worker), tools } as never, context(host, { mode }))
    expect(send('rolling', false)).toBe(golden['memory:rolling'])
    expect(send('rolling', true)).toBe(`${golden['memory:rolling']}\n\n${golden['memory:rolling-zoom']}`)
    expect(send('tree', true, true)).toBe(`${golden['memory:tree']}\n\n${golden['memory:tree-zoom']}\n\n${golden['memory:parent-zoom']}`)
  })

  it('Plan: planning with and without tools', () => {
    const plan = createPlanExtension()
    const storage = { dir: '/nowhere', read: () => undefined, write: () => {} }
    const { host } = hostFor(plan, {
      toggled: () => true,
      chatStorage: () => storage,
      storage,
      chat: () => chat(),
    } as never)
    const ctx = context(host)
    expect(plan.instructions!({ chat: chat(), tools: true } as never, ctx)).toBe(golden['plan:planning:true'])
    expect(plan.instructions!({ chat: chat(), tools: false } as never, ctx)).toBe(golden['plan:planning:false'])
    expect(plan.turnOptions!(chat() as never, ctx)).toMatchObject({ readOnly: true, reason: golden['plan:read-only-reason'] })
  })

  it('Deep Research: the chip and a worker’s prompt', () => {
    expect(CHIP_TEXT).toBe(golden['research:chip'])
    const run = { question: 'Q?', subQuestions: ['S1', 'S2'], plan: { sources: ['docs'] }, limits: { sources: 9 } } as never
    expect(workerPrompt(run, 1)).toBe(golden['research:worker'])
    const research = byId('deep-research')
    const text = (key: keyof typeof TEXT) => promptText('deep-research', { workerIntro: 'worker-intro', workerHow: 'worker-how', workerReply: 'worker-reply', plan: 'planner', review: 'reviewer', write: 'writer' }[key])
    expect(workerPrompt(run, 1, text)).toBe(golden['research:worker'])
    expect(research.prompts!.length).toBe(7)
  })
})

describe('no built-in extension sends hidden text the user can’t edit', () => {
  it.each(builtIns.filter((extension) => extension.instructions || extension.memory?.instructions).map((e) => [e.id, e] as const))(
    '%s declares a prompt for its instructions',
    (_id, extension) => {
      expect(extension.prompts?.some((prompt) => prompt.where === 'instructions')).toBe(true)
    },
  )

  it('an extension’s own chat (Home) takes its role from a prompt', () => {
    for (const extension of builtIns)
      for (const declared of extension.chats ?? []) {
        expect(declared.prompt).toBeTruthy()
        expect(extension.prompts?.find((prompt) => prompt.id === declared.prompt)?.text).toBe(declared.instructions)
      }
  })

  it('every prompt id is unique and well formed', () => {
    for (const extension of builtIns) {
      const ids = (extension.prompts ?? []).map((prompt) => prompt.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })
})
