// The evidence rules and the report. Pure: no host, no network.
//
// A finding is a claim a research worker made with an exact quote from a page and its URL. It counts only once the
// quote was found on that page as Kothar fetched it (verified). The report's text comes from the synthesis step, which
// may only cite findings by id; anything it says without a verified finding behind it is dropped, and the numbered
// citations and the source list are made here from the findings, never from the model's own text.

export type Finding = {
  id: string
  // The sub-question it answers, by index in the plan.
  sub: number
  claim: string
  quote: string
  url: string
  title: string
  verified: boolean
  // Why it was dropped, when it was.
  dropped?: string
}

export type Source = { url: string; title: string; accessedAt: string }

export type Point = { text: string; cites: string[] }

export type Synthesis = {
  summary: Point[]
  sections: { heading: string; points: Point[] }[]
  disagreements: (Point & { section?: number })[]
  confidence: { level: 'high' | 'medium' | 'low'; why: string }
  openQuestions: string[]
}

export const MIN_QUOTE = 12
export const MAX_QUOTE = 800

/** Text as it's compared: lower case, one kind of quote mark and dash, entities decoded, whitespace collapsed. */
export function normalize(text: string): string {
  return decodeEntities(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** A page's readable text and title, from its HTML (or the text itself when it isn't HTML). */
export function pageText(body: string, contentType = 'text/html'): { text: string; title?: string } {
  if (!/html|xml/i.test(contentType) && !/<html|<body|<p[\s>]/i.test(body.slice(0, 2000))) return { text: body }
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const text = body
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return { text: decodeEntities(text), ...(title && { title: decodeEntities(title).replace(/\s+/g, ' ').trim() }) }
}

/**
 * Whether the quote is on the page: the whole of it, or each part of it around an ellipsis, as a run of the page's
 * words. A quote too short to mean anything, or too long to be a quote, doesn't count.
 */
export function quoteFound(quote: string, page: string): boolean {
  const parts = quote
    .split(/\.\.\.|…|\[\.\.\.\]/)
    .map((part) => normalize(part).replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
  const length = parts.join(' ').length
  if (!parts.length || length < MIN_QUOTE || length > MAX_QUOTE) return false
  const text = normalize(page)
  let from = 0
  for (const part of parts) {
    if (part.length < 4) continue
    const at = text.indexOf(part, from)
    if (at < 0) return false
    from = at + part.length
  }
  return true
}

/** The URL a finding names, cleaned up for comparing (no fragment), or undefined if it isn't a web address. */
export function cleanUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * A research worker's findings, from its reply: the JSON inside <findings>…</findings> (or a ```json block, or the whole
 * reply). Anything that isn't a finding with a claim, a quote and a web URL is left out.
 */
export function parseFindings(reply: string): { claim: string; quote: string; url: string; title: string }[] {
  const tagged = reply.match(/<findings>([\s\S]*?)<\/findings>/i)?.[1]
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  for (const candidate of [tagged, fenced, reply]) {
    if (candidate === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate.trim())
    } catch {
      continue
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { findings?: unknown })?.findings
    if (!Array.isArray(list)) continue
    return list.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const { claim, quote, url, title } = item as Record<string, unknown>
      const clean = typeof url === 'string' ? cleanUrl(url) : undefined
      if (typeof claim !== 'string' || !claim.trim() || typeof quote !== 'string' || !quote.trim() || !clean) return []
      return [{ claim: claim.trim(), quote: quote.trim(), url: clean, title: typeof title === 'string' && title.trim() ? title.trim() : clean }]
    })
  }
  return []
}

const asText = (value: unknown, max = 2000) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/**
 * The synthesis step's answer, checked against the verified findings. Each point keeps only the cites that name a
 * verified finding; a point left with none is dropped (counted in `dropped`), and so is a section left with no points.
 * Citation marks the model wrote into its text are removed: the report numbers sources itself.
 */
export function checkSynthesis(raw: unknown, findings: readonly Finding[]): { synthesis: Synthesis; dropped: number } {
  const known = new Set(findings.filter((f) => f.verified).map((f) => f.id))
  let dropped = 0
  const point = (value: unknown): Point | undefined => {
    const item = (value ?? {}) as Record<string, unknown>
    const text = asText(item.text).replace(/\s*\[(?:\d+|F\d+)(?:[,\s]+(?:\d+|F\d+))*\]/g, '').trim()
    const cites = Array.isArray(item.cites) ? [...new Set(item.cites.filter((c): c is string => typeof c === 'string' && known.has(c)))] : []
    if (!text) return undefined
    if (!cites.length) {
      dropped++
      return undefined
    }
    return { text, cites }
  }
  const points = (value: unknown) => (Array.isArray(value) ? value.flatMap((v) => point(v) ?? []) : [])
  const data = (raw ?? {}) as Record<string, unknown>
  const sections = (Array.isArray(data.sections) ? data.sections : []).flatMap((s) => {
    const section = (s ?? {}) as Record<string, unknown>
    const heading = asText(section.heading, 120)
    const kept = points(section.points)
    return heading && kept.length ? [{ heading, points: kept }] : []
  })
  const disagreements = (Array.isArray(data.disagreements) ? data.disagreements : []).flatMap((d) => {
    const kept = point(d)
    if (!kept) return []
    const section = (d as { section?: unknown }).section
    return [{ ...kept, ...(typeof section === 'number' && Number.isInteger(section) && section >= 0 && section < sections.length && { section }) }]
  })
  const confidence = (data.confidence ?? {}) as Record<string, unknown>
  const level = confidence.level === 'high' || confidence.level === 'medium' || confidence.level === 'low' ? confidence.level : 'low'
  const openQuestions = Array.isArray(data.openQuestions) ? data.openQuestions.map((q) => asText(q, 300)).filter(Boolean).slice(0, 10) : []
  return { synthesis: { summary: points(data.summary), sections, disagreements, confidence: { level, why: asText(confidence.why, 600) }, openQuestions }, dropped }
}

/**
 * A report without the synthesis step (it failed, or the run was stopped): each sub-question's verified findings as
 * points, in the plan's order, citing themselves.
 */
export function plainSynthesis(subQuestions: readonly string[], findings: readonly Finding[]): Synthesis {
  const verified = findings.filter((f) => f.verified)
  const sections = subQuestions.flatMap((heading, sub) => {
    const points = verified.filter((f) => f.sub === sub).map((f) => ({ text: f.claim, cites: [f.id] }))
    return points.length ? [{ heading, points }] : []
  })
  return {
    summary: sections.map((s) => s.points[0]!),
    sections,
    disagreements: [],
    confidence: { level: 'low', why: 'This report lists the findings as the workers found them, without a review across sources.' },
    openQuestions: subQuestions.filter((_, sub) => !verified.some((f) => f.sub === sub)),
  }
}

export type ReportInput = {
  question: string
  synthesis: Synthesis
  findings: readonly Finding[]
  sources: Readonly<Record<string, Source>>
  // Why it's partial (stopped, budget), if it is.
  partial?: string
  // Points the synthesis made without a verified finding, and findings whose quote wasn't on their page.
  droppedPoints: number
  droppedFindings: number
}

/** The Markdown report, its short summary for the agent, and the sources it cites in order. */
export function writeReport(input: ReportInput): { markdown: string; summary: string; cited: (Source & { n: number })[] } {
  const { question, synthesis, findings, sources } = input
  const byId = new Map(findings.map((f) => [f.id, f]))
  const numbers = new Map<string, number>()
  const cited: (Source & { n: number })[] = []
  const marks = (cites: readonly string[]) => {
    const ns = new Set<number>()
    for (const id of cites) {
      const url = byId.get(id)?.url
      const source = url ? sources[url] : undefined
      if (!url || !source) continue
      let n = numbers.get(url)
      if (n === undefined) {
        n = cited.length + 1
        numbers.set(url, n)
        cited.push({ ...source, n })
      }
      ns.add(n)
    }
    return [...ns].sort((a, b) => a - b).map((n) => `[${n}]`).join('')
  }
  const line = (p: Point) => {
    const m = marks(p.cites)
    return m ? `${p.text} ${m}` : undefined
  }
  const out: string[] = [`# ${question}`, '']
  if (input.partial) out.push(`> **Partial report.** ${input.partial} It covers only what was found before then.`, '')
  out.push('## Executive summary', '')
  const summary = synthesis.summary.flatMap((p) => line(p) ?? [])
  out.push(...(summary.length ? summary.map((s) => `- ${s}`) : ['No finding could be backed by a quote from its source.']), '')
  synthesis.sections.forEach((section, index) => {
    const points = section.points.flatMap((p) => line(p) ?? [])
    if (!points.length) return
    out.push(`## ${section.heading}`, '', ...points.map((p) => `- ${p}`), '')
    for (const d of synthesis.disagreements.filter((d) => d.section === index)) {
      const text = line(d)
      if (text) out.push(`> **Sources disagree:** ${text}`, '')
    }
  })
  const loose = synthesis.disagreements.filter((d) => d.section === undefined).flatMap((d) => line(d) ?? [])
  if (loose.length) out.push('## Where sources disagree', '', ...loose.map((d) => `- ${d}`), '')
  out.push('## Confidence and open questions', '', `**Confidence: ${synthesis.confidence.level}.** ${synthesis.confidence.why}`.trim(), '')
  const dropped: string[] = []
  if (input.droppedFindings) dropped.push(`${input.droppedFindings} finding${input.droppedFindings === 1 ? '' : 's'} left out because the quote couldn't be found on its page`)
  if (input.droppedPoints) dropped.push(`${input.droppedPoints} statement${input.droppedPoints === 1 ? '' : 's'} left out for lack of a quoted source`)
  if (dropped.length) out.push(`${dropped.join('; ')}.`, '')
  if (synthesis.openQuestions.length) out.push('Open questions:', '', ...synthesis.openQuestions.map((q) => `- ${q}`), '')
  out.push('## Sources', '')
  out.push(...(cited.length ? cited.map((s) => `${s.n}. [${s.title.replace(/[[\]]/g, '')}](${s.url}), accessed ${s.accessedAt.slice(0, 10)}`) : ['None.']), '')
  const shortSummary = synthesis.summary
    .slice(0, 3)
    .flatMap((p) => line(p) ?? [])
    .join(' ')
  return { markdown: out.join('\n'), summary: shortSummary || 'No finding could be backed by a quote from its source.', cited }
}
