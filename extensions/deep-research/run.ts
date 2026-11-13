// A research run, from plan to report: plan the sub-questions, wait for the user's go-ahead, fan the sub-questions out to
// workers, check every quote against its page, run follow-up rounds on the gaps, then write the cited report and save it.
// Everything outside (the model, the workers, the web, the host) comes in as ports, so tests can fake each.
import type { CompletionRequest, ExtensionHost, ExtensionWait } from '@kothar/extension-api'
import {
  checkSynthesis,
  plainSynthesis,
  pageText,
  parseFindings,
  quoteFound,
  writeReport,
  type Finding,
  type Synthesis,
} from './report.ts'
import { ACTIVE, DEPTH_LIMITS, type Depth, type Plan, type ReportPlace, type Run, type Store } from './store.ts'

export const MIN_SUBS = 3
export const MAX_SUBS = 8
const FOLLOW_UPS_PER_ROUND = 4
const PLAN_TIMEOUT_MS = 90_000
const REVIEW_TIMEOUT_MS = 120_000
const WRITE_TIMEOUT_MS = 240_000
const MAX_FINDINGS_TEXT = 60_000
export const TITLE_CHARS = 80

export type Investigation = { reply: string; error?: string }

export type Ports = {
  host: ExtensionHost
  store: Store
  complete: (request: CompletionRequest) => Promise<string>
  // A page's body and content type; throws when it can't be fetched.
  fetchPage: (url: string, signal: AbortSignal) => Promise<{ body: string; contentType: string }>
  // One sub-question, researched by a worker. Resolves with its reply when it's done, stopped or failed.
  investigate: (run: Run, prompt: string, label: string, signal: AbortSignal) => Promise<Investigation>
  // The run changed: the Research tab draws again.
  changed: (run: Run) => void
}

export type Limits = Run['limits']

export type StartSpec = { chatId: string; spaceId: string; question: string; depth: Depth; limits: Limits; workerChat?: string }

export type Decision = { start: true; plan?: Plan } | { start: false }

export type Outcome = {
  status: 'done' | 'partial' | 'cancelled' | 'failed'
  question: string
  summary?: string
  report?: ReportPlace
  sources?: number
  error?: string
  run: string
}

/** The run's limits: the depth's, with the user's caps (0: the depth's own) applied. */
export function limitsFor(depth: Depth, caps: { workers: number; sources: number }): Limits {
  const base = DEPTH_LIMITS[depth]
  const cap = (own: number, user: number) => (user > 0 ? Math.max(1, Math.floor(user)) : own)
  const workers = cap(base.workers, caps.workers)
  return { parallel: Math.min(base.parallel, workers), workers, sources: cap(base.sources, caps.sources), rounds: base.rounds }
}

/** The model's JSON answer, with any code fence around it taken off. */
export function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text
  const start = fenced.search(/[[{]/)
  return JSON.parse(start > 0 ? fenced.slice(start) : fenced)
}

const short = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    subQuestions: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['subQuestions', 'sources'],
}

const POINT = { type: 'object', properties: { text: { type: 'string' }, cites: { type: 'array', items: { type: 'string' } } }, required: ['text', 'cites'] }

export const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'array', items: POINT },
    sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, points: { type: 'array', items: POINT } }, required: ['heading', 'points'] } },
    disagreements: { type: 'array', items: { ...POINT, properties: { ...POINT.properties, section: { type: 'integer' } } } },
    confidence: { type: 'object', properties: { level: { type: 'string', enum: ['high', 'medium', 'low'] }, why: { type: 'string' } }, required: ['level', 'why'] },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'sections', 'disagreements', 'confidence', 'openQuestions'],
}

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: { gaps: { type: 'array', items: { type: 'string' } }, contradictions: { type: 'array', items: { type: 'string' } } },
  required: ['gaps', 'contradictions'],
}

/** What a research worker is told. */
// The text of Deep Research's prompts (Settings → Extensions → Deep Research → Prompts), as sent unless the user edits
// them. The workers' and the planner's, reviewer's and writer's go to models outside the chat's turn.
export const TEXT = {
  workerIntro: "You are a research worker for Kothar's Deep Research. Research one sub-question and report evidence. Don't write a report.",
  workerHow: [
    '- Use your web search and web fetch tools first. Use a browser only when a page can’t be read otherwise (it needs JavaScript). Don’t sign in to anything, fill in forms or buy anything.',
    '- Read the pages themselves, not only search snippets. Prefer primary and authoritative sources, and recent ones where it matters.',
  ].join('\n'),
  workerReply: [
    'Reply with only this block, nothing before or after it:',
    '<findings>',
    '{"findings": [{"claim": "one fact, in your words", "quote": "the exact sentence or sentences from the page that support it, copied character for character", "url": "the page’s URL", "title": "the page’s title"}], "gaps": "what you couldn’t find"}',
    '</findings>',
    '',
    'Each quote must be copied exactly from the page at its URL: Kothar fetches every page and drops any finding whose quote isn’t on it. Never make up a quote, a URL or a title. If you found nothing reliable, reply with an empty list.',
  ].join('\n'),
  plan:
    'You plan research. Split the question into independent sub-questions that can each be researched on the web by a ' +
    'separate worker, and together answer it. Name the kinds of sources worth checking (such as official documentation, ' +
    'peer-reviewed papers, government statistics, reputable news). Answer with JSON only.',
  review:
    'You review research in progress. Name what the question still needs: sub-questions nobody answered well, and claims ' +
    'that contradict each other and need checking. Each becomes a new web research task, so make each a standalone ' +
    'question. Return empty lists when the findings already answer the question. Answer with JSON only.',
  write:
    'You write research reports from checked evidence only. Every point must cite the ids of the findings that support ' +
    'it (such as ["F2", "F7"]) and say nothing the cited quotes don’t support; a point without a supporting finding is ' +
    'dropped. Don’t write citation numbers or URLs in the text. Where findings disagree, add a disagreement citing both ' +
    'sides, with section: the index of the section it belongs to. Confidence reflects how strong and how consistent the ' +
    'sources are. Open questions are what the evidence leaves unanswered. Answer with JSON only.',
}

// Each prompt's id, for host.prompt.
export const PROMPT_IDS = {
  workerIntro: 'worker-intro',
  workerHow: 'worker-how',
  workerReply: 'worker-reply',
  plan: 'planner',
  review: 'reviewer',
  write: 'writer',
} as const satisfies Record<keyof typeof TEXT, string>

export type PromptText = (key: keyof typeof TEXT) => string
// One of the prompts as the user left it in Settings (host.prompt), else its default, as with a host that has no
// prompts (a test's).
export const promptsOf =
  (host: { prompt?: (id: string) => string } | undefined): PromptText =>
  (key) =>
    typeof host?.prompt === 'function' ? host.prompt(PROMPT_IDS[key]) : TEXT[key]

export function workerPrompt(run: Run, sub: number, text: PromptText = (key) => TEXT[key]): string {
  const sources = run.plan?.sources.length ? run.plan.sources.join('; ') : 'whatever is most authoritative'
  const perWorker = Math.max(2, Math.ceil(run.limits.sources / Math.max(1, run.subQuestions.length)))
  return [
    text('workerIntro'),
    '',
    `Overall question: ${run.question}`,
    `Your sub-question: ${run.subQuestions[sub]}`,
    `Kinds of sources to check: ${sources}`,
    '',
    'How to work:',
    text('workerHow'),
    `- Aim for 3 to 8 findings from at most ${perWorker} different pages.`,
    '',
    text('workerReply'),
  ].join('\n')
}

export function openResearch(ports: Ports) {
  const { host, store } = ports
  type Live = { run: Run; abort: AbortController; stopped?: string; decide?: (decision: Decision) => void; pages: Map<string, Promise<string | undefined>> }
  const live = new Map<string, Live>()
  const save = (run: Run) => {
    store.save(run)
    ports.changed(run)
  }
  const nextId = () => {
    const stamp = host.now().getTime().toString(36)
    let id = stamp
    for (let n = 2; live.has(id); n++) id = `${stamp}-${n}`
    return id
  }

  const makePlan = async (run: Run): Promise<Plan> => {
    const subs = DEPTH_LIMITS[run.depth].subs
    try {
      const text = await ports.complete({
        system: promptsOf(host)('plan'),
        chatId: run.chatId,
        prompt: `Question: ${run.question}\n\nGive ${subs} sub-questions (never more than ${MAX_SUBS}), each one line, and 2 to 5 kinds of sources.`,
        schema: PLAN_SCHEMA,
        timeoutMs: PLAN_TIMEOUT_MS,
      })
      return checkPlan(parseJson(text)) ?? { subQuestions: [run.question], sources: [] }
    } catch {
      return { subQuestions: [run.question], sources: [] }
    }
  }

  // Waits for the user's go-ahead: the wait bar on the chat whose turn asked (the tool), or the Research tab alone.
  const approval = (entry: Live, waitOn: string | undefined): Promise<Decision> => {
    const { run } = entry
    run.phase = 'awaiting'
    save(run)
    return new Promise<Decision>((resolve) => {
      entry.decide = (decision) => {
        entry.decide = undefined
        if (waitOn) {
          try {
            host.endWait(waitOn)
          } catch {
            // The chat went; the run decides anyway.
          }
        }
        resolve(decision)
      }
      if (waitOn) {
        const count = run.subQuestions.length
        host.wait(waitOn, planWait(run.question, count))
        try {
          host.showPanel(waitOn, 'research')
        } catch {
          // No tab to show; the bar still asks.
        }
      }
    })
  }

  // Each finding's quote, checked on its page as fetched now. A page is fetched once per run.
  const verify = async (entry: Live, sub: number, found: ReturnType<typeof parseFindings>) => {
    const { run } = entry
    const accessedAt = host.now().toISOString()
    for (const item of found) {
      const id = `F${run.findings.length + 1}`
      const finding: Finding = { id, sub, ...item, verified: false }
      run.findings.push(finding)
      const known = run.sources[item.url]
      if (!known && Object.keys(run.sources).length >= run.limits.sources) {
        finding.dropped = 'over the run’s source budget'
        run.partial ??= `It reached its budget of ${run.limits.sources} sources.`
        continue
      }
      let page = entry.pages.get(item.url)
      if (!page) {
        page = ports.fetchPage(item.url, entry.abort.signal).then(
          ({ body, contentType }) => {
            const { text, title } = pageText(body, contentType)
            if (title) titles.set(item.url, title)
            return text
          },
          () => undefined,
        )
        entry.pages.set(item.url, page)
      }
      const text = await page
      if (text === undefined) {
        finding.dropped = 'the page couldn’t be fetched to check the quote'
        continue
      }
      if (!quoteFound(item.quote, text)) {
        finding.dropped = 'the quote isn’t on the page'
        continue
      }
      finding.verified = true
      if (!known) run.sources[item.url] = { url: item.url, title: short(titles.get(item.url) ?? item.title, 200), accessedAt }
    }
  }
  const titles = new Map<string, string>()

  // One round: each sub-question to a worker, at most `parallel` at once, within the run's worker budget.
  const fanOut = async (entry: Live, subs: number[]) => {
    const { run } = entry
    const queue = [...subs]
    const runOne = async (): Promise<void> => {
      const sub = queue.shift()
      if (sub === undefined || entry.stopped) return
      if (run.workers.length >= run.limits.workers) {
        run.partial ??= `It reached its budget of ${run.limits.workers} workers.`
        queue.length = 0
        return
      }
      const record = { chatId: '', sub, round: run.round, state: 'running' as const }
      run.workers.push(record)
      save(run)
      const label = `Research: ${short(run.subQuestions[sub]!, 60)}`
      let result: Investigation
      try {
        result = await ports.investigate(run, workerPrompt(run, sub, promptsOf(host)), label, entry.abort.signal)
      } catch (error) {
        result = { reply: '', error: error instanceof Error ? error.message : String(error) }
      }
      const done = run.workers.find((w) => w === record)!
      Object.assign(done, { state: entry.stopped ? 'stopped' : result.error ? 'failed' : 'done', ...(result.error && { error: result.error }) })
      await verify(entry, sub, parseFindings(result.reply))
      save(run)
      return runOne()
    }
    await Promise.all(Array.from({ length: Math.min(run.limits.parallel, queue.length) }, runOne))
  }

  // Follow-up questions for the gaps and contradictions in what was found, or none.
  const review = async (run: Run): Promise<string[]> => {
    const left = run.limits.workers - run.workers.length
    if (left <= 0) return []
    const verified = run.findings.filter((f) => f.verified)
    const text = await ports.complete({
      system: promptsOf(host)('review'),
      chatId: run.chatId,
      prompt: [
        `Question: ${run.question}`,
        '',
        'Sub-questions so far:',
        ...run.subQuestions.map((q, i) => `${i + 1}. ${q} (${verified.filter((f) => f.sub === i).length} checked findings)`),
        '',
        'Checked findings:',
        ...verified.map((f) => `- [${f.sub + 1}] ${f.claim}`),
        '',
        `At most ${Math.min(FOLLOW_UPS_PER_ROUND, left)} gaps and contradictions together.`,
      ].join('\n'),
      schema: REVIEW_SCHEMA,
      timeoutMs: REVIEW_TIMEOUT_MS,
    })
    const data = parseJson(text) as { gaps?: unknown; contradictions?: unknown }
    const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [])
    const asked = new Set(run.subQuestions.map((q) => q.toLowerCase().trim()))
    return [...list(data.gaps), ...list(data.contradictions).map((c) => `Check which is right: ${c}`)]
      .map((q) => short(q, 300))
      .filter((q) => !asked.has(q.toLowerCase()))
      .slice(0, Math.min(FOLLOW_UPS_PER_ROUND, left))
  }

  const synthesize = async (run: Run): Promise<{ synthesis: Synthesis; dropped: number }> => {
    const verified = run.findings.filter((f) => f.verified)
    let listed = ''
    for (const f of verified) {
      const line = `${f.id} (sub-question ${f.sub + 1}; ${run.sources[f.url]?.title ?? f.title}, ${f.url}): ${f.claim}\n    Quote: "${f.quote}"\n`
      if (listed.length + line.length > MAX_FINDINGS_TEXT) break
      listed += line
    }
    const text = await ports.complete({
      system: promptsOf(host)('write'),
      chatId: run.chatId,
      prompt: [
        `Question: ${run.question}`,
        '',
        'Sub-questions:',
        ...run.subQuestions.map((q, i) => `${i + 1}. ${q}`),
        '',
        'Checked findings:',
        listed || '(none)',
        '',
        'Write an executive summary of 3 to 6 points, then a section per theme (use the sub-questions as a guide).',
      ].join('\n'),
      schema: WRITE_SCHEMA,
      timeoutMs: WRITE_TIMEOUT_MS,
    })
    return checkSynthesis(parseJson(text), run.findings)
  }

  // Saves the report: as an artifact if the Artifacts extension is on for the space, else a note if Notes is, else a
  // file in the space's chat folder.
  const place = async (run: Run, markdown: string, description: string): Promise<ReportPlace> => {
    const title = short(`Research: ${run.question}`, TITLE_CHARS)
    try {
      const made = (await host.callTool(run.spaceId, 'create_artifact', { title, type: 'markdown', content: markdown, description: short(description, 200) })) as {
        id?: string
        title?: string
      }
      return { kind: 'artifact', title: made?.title ?? title, ref: made?.id ?? title }
    } catch {
      // No Artifacts here: try Notes.
    }
    try {
      const name = short(`Research ${run.question.replace(/[\\/:*?"<>|#^[\]]/g, ' ')}`, TITLE_CHARS)
      const saved = (await host.callTool(run.spaceId, 'write_note', { name, body: markdown, description: short(description, 200), scope: 'space' })) as {
        saved?: { name?: string }
      }
      return { kind: 'note', title: saved?.saved?.name ?? name, ref: saved?.saved?.name ?? name }
    } catch {
      // No Notes either: a file.
    }
    const name = `research/${run.id}.md`
    const storage = host.chatStorage(run.spaceId)
    storage.write(name, markdown)
    return { kind: 'file', title, ref: `${storage.dir}/${name}` }
  }

  // Writes and saves the report from what was found, and ends the run.
  const finish = async (entry: Live): Promise<Outcome> => {
    const { run } = entry
    if (entry.stopped) run.partial = entry.stopped
    run.phase = 'writing'
    save(run)
    let checked: { synthesis: Synthesis; dropped: number }
    try {
      if (entry.stopped) throw new Error('stopped')
      checked = await synthesize(run)
      if (!checked.synthesis.sections.length && run.findings.some((f) => f.verified)) throw new Error('nothing kept')
    } catch {
      checked = { synthesis: plainSynthesis(run.subQuestions, run.findings), dropped: 0 }
    }
    const { markdown, summary, cited } = writeReport({
      question: run.question,
      synthesis: checked.synthesis,
      findings: run.findings,
      sources: run.sources,
      ...(run.partial && { partial: run.partial }),
      droppedPoints: checked.dropped,
      droppedFindings: run.findings.filter((f) => !f.verified).length,
    })
    store.saveReport(run, markdown)
    run.summary = summary
    try {
      run.report = await place(run, markdown, summary)
    } catch (error) {
      run.error = `The report couldn’t be saved: ${error instanceof Error ? error.message : String(error)}`
    }
    run.phase = entry.stopped ? 'stopped' : 'done'
    run.endedAt = host.now().toISOString()
    save(run)
    live.delete(run.id)
    // An artifact posts its own card in the chat; one card per report is enough.
    if (run.report?.kind !== 'artifact') {
      try {
        host.note(run.chatId, summary, {
          panel: 'research',
          action: { name: 'open', value: run.id },
          card: { title: short(run.question, 120), badge: run.partial ? 'Partial research' : 'Research', detail: `${cited.length} source${cited.length === 1 ? '' : 's'}` },
        })
      } catch {
        // The chat went.
      }
    }
    return {
      status: run.partial ? 'partial' : 'done',
      question: run.question,
      summary,
      ...(run.report && { report: run.report }),
      sources: cited.length,
      ...(run.error && { error: run.error }),
      run: run.id,
    }
  }

  const research = async (entry: Live): Promise<Outcome> => {
    const { run } = entry
    let subs = run.subQuestions.map((_, i) => i)
    while (subs.length && !entry.stopped) {
      run.phase = 'researching'
      save(run)
      await fanOut(entry, subs)
      if (entry.stopped || run.round >= run.limits.rounds || run.workers.length >= run.limits.workers) break
      run.phase = 'reviewing'
      save(run)
      let more: string[] = []
      try {
        more = await review(run)
      } catch {
        more = []
      }
      if (entry.stopped || !more.length) break
      run.round++
      const from = run.subQuestions.length
      run.subQuestions.push(...more)
      subs = more.map((_, i) => from + i)
    }
    return finish(entry)
  }

  const fail = (entry: Live, error: unknown): Outcome => {
    const { run } = entry
    run.phase = 'failed'
    run.error = error instanceof Error ? error.message : String(error)
    run.endedAt = host.now().toISOString()
    save(run)
    live.delete(run.id)
    return { status: 'failed', question: run.question, error: run.error, run: run.id }
  }

  return {
    /** A new run, planning. */
    create(spec: StartSpec): Run {
      const run: Run = {
        id: nextId(),
        spaceId: spec.spaceId,
        chatId: spec.chatId,
        question: spec.question.trim(),
        depth: spec.depth,
        phase: 'planning',
        startedAt: host.now().toISOString(),
        round: 0,
        subQuestions: [],
        workers: [],
        findings: [],
        sources: {},
        limits: spec.limits,
      }
      live.set(run.id, { run, abort: new AbortController(), pages: new Map() })
      save(run)
      return run
    },
    /**
     * Plans, asks (unless askFirst is off), researches and writes the report. waitOn: the chat whose running turn shows
     * the plan bar; without it the plan waits in the Research tab.
     */
    async execute(runId: string, options: { askFirst: boolean; waitOn?: string }): Promise<Outcome> {
      const entry = live.get(runId)
      if (!entry) throw new Error('No such research is running')
      const { run } = entry
      try {
        run.plan = await makePlan(run)
        run.subQuestions = [...run.plan.subQuestions]
        if (entry.stopped) return cancel(entry)
        if (options.askFirst) {
          const decision = await approval(entry, options.waitOn)
          if (!decision.start) return cancel(entry)
          if (decision.plan) {
            run.plan = decision.plan
            run.subQuestions = [...decision.plan.subQuestions]
          }
        }
        return await research(entry)
      } catch (error) {
        return fail(entry, error)
      }
    },
    /** The user's answer to a plan waiting for it, from the bar or the tab. */
    decide(runId: string, decision: Decision) {
      const entry = live.get(runId)
      if (!entry?.decide) return false
      entry.decide(decision)
      return true
    },
    /** The run waiting on this chat's bar, if any. */
    awaitingOn: (chatId: string) => [...live.values()].find((e) => e.decide && e.run.chatId === chatId)?.run,
    /** Stops a run: workers are stopped and the report is written from what was found, marked partial. */
    stop(runId: string, why = 'You stopped it.') {
      const entry = live.get(runId)
      if (!entry || entry.stopped) return false
      entry.stopped = why
      entry.abort.abort()
      entry.decide?.({ start: false })
      return true
    },
    isLive: (runId: string) => live.has(runId),
    liveRuns: () => [...live.values()].map((e) => e.run),
    /** A run Kothar quit in the middle of: its report from what it had found, marked partial. */
    async recover(run: Run) {
      if (!ACTIVE.includes(run.phase) || live.has(run.id)) return
      const entry: Live = { run, abort: new AbortController(), pages: new Map(), stopped: 'Kothar quit before it finished.' }
      live.set(run.id, entry)
      if (!run.workers.length) return void cancel(entry)
      for (const w of run.workers) if (w.state === 'running') w.state = 'stopped'
      await finish(entry).catch((error) => fail(entry, error))
    },
  }

  function cancel(entry: Live): Outcome {
    const { run } = entry
    run.phase = 'cancelled'
    run.endedAt = host.now().toISOString()
    save(run)
    live.delete(run.id)
    return { status: 'cancelled', question: run.question, run: run.id }
  }
}

/** The plan as the model gave it, checked: one-line sub-questions (no repeats, at most MAX_SUBS) and source kinds. */
export function checkPlan(raw: unknown): Plan | undefined {
  const data = (raw ?? {}) as Record<string, unknown>
  const lines = (value: unknown, max: number) =>
    Array.isArray(value)
      ? [...new Set(value.filter((v): v is string => typeof v === 'string').map((v) => short(v, 300)).filter(Boolean))].slice(0, max)
      : []
  const subQuestions = lines(data.subQuestions, MAX_SUBS)
  return subQuestions.length ? { subQuestions, sources: lines(data.sources, 8) } : undefined
}

/** A plan typed by the user: one sub-question per line, list marks taken off. */
export function planFromText(text: string, sources: string[] = []): Plan | undefined {
  const subQuestions = text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
  return checkPlan({ subQuestions, sources })
}

/** What the plan bar says, and its buttons. */
export function planWait(question: string, count: number): ExtensionWait {
  return {
    text: `Research plan for "${short(question, 80)}": ${count} sub-question${count === 1 ? '' : 's'}, in the Research tab. Start it?`,
    buttons: [
      { id: 'start', label: 'Start', primary: true, closes: true, hint: 'Research the plan as it is' },
      { id: 'edit', label: 'Edit', closes: true, hint: 'Change the sub-questions in the Research tab, then start' },
      { id: 'cancel', label: 'Cancel', closes: true, hint: 'Don’t research this' },
    ],
  }
}
