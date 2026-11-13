import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CompletionRequest, ExtensionHost, ExtensionStorage, ExtensionWait } from '@kothar/extension-api'
import { until } from '@kothar/core/test-wait'
import { afterEach, describe, expect, it } from 'vitest'
import { limitsFor, openResearch, PLAN_SCHEMA, REVIEW_SCHEMA, WRITE_SCHEMA, type Investigation, type Limits } from './run.ts'
import { openStore, type Run } from './store.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

// Plain files under dir, as host.storage keeps them.
function storageAt(dir: string, _what: string): ExtensionStorage {
  const at = (name: string) => join(dir, name)
  const writable = (name: string) => (mkdirSync(dirname(at(name)), { recursive: true }), at(name))
  return {
    dir,
    read: (name) => {
      try {
        return readFileSync(at(name), 'utf8')
      } catch {
        return undefined
      }
    },
    write: (name, text) => writeFileSync(writable(name), text),
    append: (name, text) => appendFileSync(writable(name), text),
    remove: (name) => rmSync(at(name), { force: true }),
    list: (folder = '') => {
      try {
        return readdirSync(at(folder))
          .sort()
          .flatMap((name) => (statSync(join(at(folder), name)).isFile() ? [{ name, size: statSync(join(at(folder), name)).size }] : []))
      } catch {
        return []
      }
    },
  }
}

const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-research-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// The web as the fake workers cite it: each page's text by URL. A URL missing here can't be fetched.
const PAGES: Record<string, string> = {
  'https://a.test/': '<title>Page A</title><p>Alpha is the first letter of the Greek alphabet.</p>',
  'https://b.test/': '<title>Page B</title><p>Beta comes second in the Greek alphabet, after alpha.</p>',
  'https://c.test/': '<title>Page C</title><p>Gamma is third.</p>',
}

const findingFor = (sub: number, url = 'https://a.test/', quote = 'Alpha is the first letter of the Greek alphabet') =>
  ({ claim: `Claim for sub ${sub} from ${url}`, quote, url, title: 'Worker title' })

type Options = {
  plan?: string[]
  // What each review round says is missing.
  gaps?: (round: number) => string[]
  // What a worker replies for a prompt (the sub-question is in it).
  reply?: (prompt: string) => object[]
  // How long a worker takes, ms.
  workerMs?: number
  // Which tools the space has, in fallback order.
  tools?: ('create_artifact' | 'write_note')[]
  writeFails?: boolean
  limits?: Partial<Limits>
}

function setup(options: Options = {}) {
  const dir = tempDir()
  const chatDir = join(dir, 'chat')
  const waits: (ExtensionWait | undefined)[] = []
  const notes: { text: string; card?: unknown }[] = []
  const calls: { name: string; input: Record<string, unknown> }[] = []
  const requests: CompletionRequest[] = []
  let reviews = 0
  let running = 0
  let mostAtOnce = 0
  const asked: string[] = []
  let clock = Date.parse('2026-11-12T10:00:00.000Z')
  const host = {
    now: () => new Date((clock += 1000)),
    wait: (_chatId: string, wait: ExtensionWait) => void waits.push(wait),
    endWait: () => void waits.push(undefined),
    showPanel: () => {},
    refresh: () => {},
    note: (_chatId: string, text: string, opts?: { card?: unknown }) => void notes.push({ text, card: opts?.card }),
    interrupt: () => {},
    chatStorage: () => storageAt(chatDir, 'chat'),
    async callTool(_chatId: string, name: string, input: Record<string, unknown>) {
      if (!(options.tools ?? []).includes(name as 'write_note')) throw new Error(`No tool "${name}" is on for Space`)
      calls.push({ name, input })
      return name === 'create_artifact' ? { id: 'research-q', title: input.title } : { saved: { name: input.name } }
    },
  } as unknown as ExtensionHost
  const store = openStore(storageAt(join(dir, 'ext'), 'storage'))
  const complete = async (request: CompletionRequest) => {
    requests.push(request)
    if (request.schema === PLAN_SCHEMA) return JSON.stringify({ subQuestions: options.plan ?? ['Sub A?', 'Sub B?', 'Sub C?'], sources: ['encyclopedias'] })
    if (request.schema === REVIEW_SCHEMA) return JSON.stringify({ gaps: options.gaps?.(reviews++) ?? [], contradictions: [] })
    if (request.schema === WRITE_SCHEMA) {
      if (options.writeFails) throw new Error('no engine')
      const ids = [...request.prompt.matchAll(/^(F\d+) /gm)].map((m) => m[1]!)
      return JSON.stringify({
        summary: [{ text: 'Backed summary', cites: ids.slice(0, 1) }, { text: 'Invented claim', cites: [] }],
        sections: [{ heading: 'Letters', points: ids.map((id) => ({ text: `Point ${id}`, cites: [id] })) }],
        disagreements: [],
        confidence: { level: 'medium', why: 'Few sources' },
        openQuestions: [],
      })
    }
    throw new Error('unexpected request')
  }
  const investigate = async (_run: Run, prompt: string, _label: string, signal: AbortSignal): Promise<Investigation> => {
    asked.push(prompt.match(/Your sub-question: (.*)/)![1]!)
    running++
    mostAtOnce = Math.max(mostAtOnce, running)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.workerMs ?? 5)
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })
    running--
    const sub = Number(prompt.match(/Sub (\w)/)?.[1]?.charCodeAt(0) ?? 65) - 65
    const findings = options.reply ? options.reply(prompt) : [findingFor(sub)]
    return { reply: `<findings>${JSON.stringify({ findings })}</findings>`, ...(signal.aborted && { error: 'Interrupted' }) }
  }
  const fetchPage = async (url: string) => {
    const body = PAGES[url]
    if (!body) throw new Error('HTTP 404')
    return { body, contentType: 'text/html' }
  }
  const research = openResearch({ host, store, complete, fetchPage, investigate, changed: () => {} })
  const limits: Limits = { ...limitsFor('standard', { workers: 0, sources: 0 }), ...options.limits }
  const begin = (askFirst = false, waitOn: string | undefined = askFirst ? 'space' : undefined) => {
    const run = research.create({ chatId: 'space', spaceId: 'space', question: 'Greek letters?', depth: 'standard', limits })
    return { run, done: research.execute(run.id, { askFirst, ...(waitOn && { waitOn }) }) }
  }
  return { research, store, waits, notes, calls, requests, asked, begin, chatDir, mostAtOnce: () => mostAtOnce }
}

describe('a research run', () => {
  it('shows its plan on the chat’s bar and waits for Start', async () => {
    const t = setup()
    const { run, done } = t.begin(true)
    await until(() => t.waits.length > 0)
    expect(t.waits[0]).toMatchObject({
      text: expect.stringContaining('3 sub-questions'),
      buttons: [
        { id: 'start', primary: true, closes: true },
        { id: 'edit', closes: true },
        { id: 'cancel', closes: true },
      ],
    })
    expect(t.store.read('space', run.id)).toMatchObject({ phase: 'awaiting', subQuestions: ['Sub A?', 'Sub B?', 'Sub C?'] })
    expect(t.asked).toEqual([])
    expect(t.research.awaitingOn('space')?.id).toBe(run.id)
    t.research.decide(run.id, { start: true })
    expect(await done).toMatchObject({ status: 'done' })
    expect(t.asked).toEqual(['Sub A?', 'Sub B?', 'Sub C?'])
    expect(t.waits.at(-1)).toBeUndefined()
  })

  it('does nothing more when the plan is cancelled', async () => {
    const t = setup()
    const { run, done } = t.begin(true)
    await until(() => t.waits.length > 0)
    t.research.decide(run.id, { start: false })
    expect(await done).toMatchObject({ status: 'cancelled' })
    expect(t.asked).toEqual([])
    expect(t.store.read('space', run.id)?.phase).toBe('cancelled')
    expect(t.calls).toEqual([])
  })

  it('researches the plan as the user edited it', async () => {
    const t = setup()
    const { run, done } = t.begin(true)
    await until(() => t.waits.length > 0)
    t.research.decide(run.id, { start: true, plan: { subQuestions: ['Sub B?'], sources: [] } })
    await done
    expect(t.asked).toEqual(['Sub B?'])
  })

  it('fans out at most `parallel` workers at once', async () => {
    const t = setup({ plan: ['Sub A?', 'Sub B?', 'Sub C?', 'Sub D?', 'Sub E?', 'Sub F?'], workerMs: 20, limits: { parallel: 2, rounds: 0 } })
    await t.begin().done
    expect(t.asked).toHaveLength(6)
    expect(t.mostAtOnce()).toBe(2)
  })

  it('runs a follow-up round on the gaps, and stops at the depth’s limit', async () => {
    const t = setup({ gaps: (round) => [`Sub ${'XYZ'[round]}? gap ${round}`], limits: { rounds: 2 } })
    const outcome = await t.begin().done
    expect(t.asked).toEqual(['Sub A?', 'Sub B?', 'Sub C?', 'Sub X? gap 0', 'Sub Y? gap 1'])
    // Two follow-up rounds, then no third review.
    expect(t.requests.filter((r) => r.schema === REVIEW_SCHEMA)).toHaveLength(2)
    expect(outcome.status).toBe('done')
  })

  it('skips the follow-up round when nothing is missing', async () => {
    const t = setup({ gaps: () => [] })
    await t.begin().done
    expect(t.asked).toHaveLength(3)
    expect(t.requests.filter((r) => r.schema === REVIEW_SCHEMA)).toHaveLength(1)
  })

  it('keeps only findings whose quote is on their page, and cites only them, every one from the stored sources', async () => {
    const t = setup({
      reply: () => [
        findingFor(0),
        findingFor(0, 'https://b.test/', 'Beta comes second in the Greek alphabet'),
        findingFor(0, 'https://b.test/', 'Beta is the last letter of the alphabet'),
        findingFor(0, 'https://missing.test/', 'Anything at all goes here'),
      ],
      limits: { rounds: 0 },
    })
    const { run, done } = t.begin()
    const outcome = await done
    const saved = t.store.read('space', run.id)!
    expect(Object.keys(saved.sources).sort()).toEqual(['https://a.test/', 'https://b.test/'])
    expect(saved.sources['https://a.test/']!.title).toBe('Page A')
    expect(saved.findings.filter((f) => !f.verified).map((f) => f.dropped)).toEqual(
      expect.arrayContaining(['the quote isn’t on the page', 'the page couldn’t be fetched to check the quote']),
    )
    const report = t.store.readReport('space', run.id)!
    // The synthesis's uncited claim is gone; every citation is a numbered source listed below.
    expect(report).not.toContain('Invented claim')
    expect(report).toContain('statement left out for lack of a quoted source')
    const listed = [...report.matchAll(/^(\d+)\. \[[^\]]+\]\((https:[^)]+)\)/gm)].map((m) => [Number(m[1]), m[2]])
    expect(listed.map(([, url]) => url).sort()).toEqual(['https://a.test/', 'https://b.test/'])
    const cited = new Set([...report.matchAll(/\[(\d+)\](?!\()/g)].map((m) => Number(m[1])))
    expect([...cited].sort()).toEqual(listed.map(([n]) => n).sort())
    expect(outcome).toMatchObject({ status: 'done', sources: 2 })
  })

  it('writes a partial report from what was found when stopped', async () => {
    const t = setup({ workerMs: 10_000, limits: { parallel: 1, rounds: 0 } })
    const { run, done } = t.begin()
    await until(() => t.asked.length === 1)
    t.research.stop(run.id)
    const outcome = await done
    expect(outcome.status).toBe('partial')
    expect(t.asked).toHaveLength(1)
    const saved = t.store.read('space', run.id)!
    expect(saved).toMatchObject({ phase: 'stopped', partial: 'You stopped it.' })
    expect(saved.workers).toMatchObject([{ state: 'stopped' }])
    expect(t.store.readReport('space', run.id)).toContain('**Partial report.** You stopped it.')
    // Stopped: written without another model call.
    expect(t.requests.filter((r) => r.schema === WRITE_SCHEMA)).toHaveLength(0)
    expect(t.notes.at(-1)?.card).toMatchObject({ badge: 'Partial research' })
  })

  it('stays within its worker budget, and says so', async () => {
    const t = setup({ plan: ['Sub A?', 'Sub B?', 'Sub C?', 'Sub D?'], gaps: () => ['Sub E? more'], limits: { workers: 2, parallel: 3 } })
    const outcome = await t.begin().done
    expect(t.asked).toHaveLength(2)
    expect(outcome.status).toBe('partial')
    expect(t.store.list('space')[0]!.partial).toBe('It reached its budget of 2 workers.')
  })

  it('stays within its source budget', async () => {
    const t = setup({
      reply: () => [findingFor(0), findingFor(0, 'https://b.test/', 'Beta comes second in the Greek alphabet'), findingFor(0, 'https://c.test/', 'Gamma is third and that is all')],
      limits: { sources: 1, rounds: 0 },
    })
    const { run, done } = t.begin()
    await done
    const saved = t.store.read('space', run.id)!
    expect(Object.keys(saved.sources)).toEqual(['https://a.test/'])
    expect(saved.findings.some((f) => f.dropped === 'over the run’s source budget')).toBe(true)
    expect(saved.partial).toBe('It reached its budget of 1 sources.')
  })

  it('writes the report without the model when it can’t be reached', async () => {
    const t = setup({ writeFails: true, limits: { rounds: 0 } })
    const { run, done } = t.begin()
    await done
    const report = t.store.readReport('space', run.id)!
    expect(report).toContain('## Sub A?')
    expect(report).toContain('**Confidence: low.**')
  })
})

describe('where the report goes', () => {
  it('is an artifact when the Artifacts extension is on', async () => {
    const t = setup({ tools: ['create_artifact', 'write_note'], limits: { rounds: 0 } })
    const outcome = await t.begin().done
    expect(t.calls.map((c) => c.name)).toEqual(['create_artifact'])
    expect(t.calls[0]!.input).toMatchObject({ type: 'markdown', title: 'Research: Greek letters?', content: expect.stringContaining('# Greek letters?') })
    expect(outcome.report).toEqual({ kind: 'artifact', title: 'Research: Greek letters?', ref: 'research-q' })
  })

  it('is a note when only Notes is on', async () => {
    const t = setup({ tools: ['write_note'], limits: { rounds: 0 } })
    const outcome = await t.begin().done
    expect(t.calls).toMatchObject([{ name: 'write_note', input: { scope: 'space', body: expect.stringContaining('## Sources') } }])
    expect(outcome.report).toMatchObject({ kind: 'note', title: 'Research Greek letters' })
  })

  it('is a file in the chat’s folder otherwise', async () => {
    const t = setup({ limits: { rounds: 0 } })
    const { run, done } = t.begin()
    const outcome = await done
    expect(outcome.report).toEqual({ kind: 'file', title: 'Research: Greek letters?', ref: join(t.chatDir, `research/${run.id}.md`) })
    expect(storageAt(t.chatDir, 'chat').read(`research/${run.id}.md`)).toContain('# Greek letters?')
  })
})
