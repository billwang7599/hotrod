import { describe, expect, it } from 'vitest'
import { checkSynthesis, cleanUrl, pageText, parseFindings, plainSynthesis, quoteFound, writeReport, type Finding } from './report.ts'
import { checkPlan, limitsFor, parseJson, planFromText } from './run.ts'

const finding = (id: string, url: string, verified = true, sub = 0): Finding => ({
  id,
  sub,
  claim: `Claim ${id}`,
  quote: 'q',
  url,
  title: `Title ${id}`,
  verified,
})

describe('quotes', () => {
  const page = pageText(
    '<html><head><title>Rayleigh &amp; the sky</title><script>var x = "The sky is green"</script></head>' +
      '<body><p>The sky looks blue because air scatters short (blue) wavelengths more&nbsp;than long ones.</p>' +
      '<p>Sunsets look red for the same reason.</p></body></html>',
  )

  it('reads a page’s text and title, without its scripts', () => {
    expect(page.title).toBe('Rayleigh & the sky')
    expect(page.text).toContain('The sky looks blue')
    expect(page.text).not.toContain('green')
  })

  it('finds a quote on its page, ignoring case, spacing and curly quote marks', () => {
    expect(quoteFound('the sky looks BLUE because air   scatters short (blue) wavelengths', page.text)).toBe(true)
    expect(quoteFound('“The sky looks blue because air scatters short (blue) wavelengths more than long ones.”', page.text)).toBe(true)
  })

  it('finds a quote around an ellipsis only with its parts in order', () => {
    expect(quoteFound('The sky looks blue because … Sunsets look red', page.text)).toBe(true)
    expect(quoteFound('Sunsets look red … The sky looks blue because', page.text)).toBe(false)
  })

  it('refuses a quote that isn’t there, or is too short to count', () => {
    expect(quoteFound('The sky looks green because of chlorophyll', page.text)).toBe(false)
    expect(quoteFound('sky', page.text)).toBe(false)
    expect(quoteFound('The sky is green', page.text)).toBe(false)
  })
})

describe('findings', () => {
  it('reads a worker’s tagged JSON, keeping only findings with a claim, a quote and a web URL', () => {
    const reply = `Here you go\n<findings>${JSON.stringify({
      findings: [
        { claim: 'Air scatters blue', quote: 'air scatters short wavelengths', url: 'https://a.test/x#part', title: 'A' },
        { claim: 'No quote', url: 'https://a.test/y' },
        { claim: 'Bad url', quote: 'q', url: 'javascript:alert(1)' },
        { claim: 'No title', quote: 'qq', url: 'https://b.test/' },
      ],
    })}</findings>`
    expect(parseFindings(reply)).toEqual([
      { claim: 'Air scatters blue', quote: 'air scatters short wavelengths', url: 'https://a.test/x', title: 'A' },
      { claim: 'No title', quote: 'qq', url: 'https://b.test/', title: 'https://b.test/' },
    ])
  })

  it('reads a fenced block or a bare list, and nothing from prose', () => {
    expect(parseFindings('```json\n[{"claim":"c","quote":"q","url":"https://x.test"}]\n```')).toHaveLength(1)
    expect(parseFindings('I could not find anything.')).toEqual([])
    expect(cleanUrl('ftp://x.test')).toBeUndefined()
  })
})

describe('the synthesis check', () => {
  const findings = [finding('F1', 'https://a.test/'), finding('F2', 'https://b.test/'), finding('F3', 'https://c.test/', false)]

  it('drops a point with no verified finding behind it, and cites only verified findings', () => {
    const { synthesis, dropped } = checkSynthesis(
      {
        summary: [
          { text: 'Backed [3]', cites: ['F1', 'F3'] },
          { text: 'Made up', cites: [] },
          { text: 'Cites only an unchecked finding', cites: ['F3'] },
          { text: 'Cites nothing real', cites: ['F9'] },
        ],
        sections: [
          { heading: 'Why', points: [{ text: 'Because', cites: ['F2'] }] },
          { heading: 'Empty', points: [{ text: 'Unbacked', cites: [] }] },
        ],
        disagreements: [{ text: 'A and B differ', cites: ['F1', 'F2'], section: 0 }],
        confidence: { level: 'medium', why: 'Two sources' },
        openQuestions: ['What about Mars?'],
      },
      findings,
    )
    expect(synthesis.summary).toEqual([{ text: 'Backed', cites: ['F1'] }])
    expect(synthesis.sections).toEqual([{ heading: 'Why', points: [{ text: 'Because', cites: ['F2'] }] }])
    expect(synthesis.disagreements).toEqual([{ text: 'A and B differ', cites: ['F1', 'F2'], section: 0 }])
    expect(dropped).toBe(4)
  })

  it('takes a broken answer as empty, with low confidence', () => {
    expect(checkSynthesis('nonsense', findings).synthesis).toMatchObject({ summary: [], sections: [], confidence: { level: 'low' } })
  })
})

describe('the report', () => {
  const findings = [
    finding('F1', 'https://a.test/'),
    finding('F2', 'https://b.test/'),
    finding('F3', 'https://a.test/'),
    finding('F4', 'https://d.test/', false),
  ]
  const sources = {
    'https://a.test/': { url: 'https://a.test/', title: 'Source A', accessedAt: '2026-11-12T10:00:00.000Z' },
    'https://b.test/': { url: 'https://b.test/', title: 'Source B', accessedAt: '2026-11-12T10:00:00.000Z' },
  }

  it('numbers sources in order of first citation, and every citation matches a listed source', () => {
    const { markdown, cited, summary } = writeReport({
      question: 'Why is the sky blue?',
      synthesis: {
        summary: [{ text: 'Scattering', cites: ['F2'] }],
        sections: [{ heading: 'Physics', points: [{ text: 'Short waves scatter', cites: ['F1', 'F3'] }, { text: 'Both', cites: ['F3', 'F2'] }] }],
        disagreements: [{ text: 'They differ on degree', cites: ['F1', 'F2'], section: 0 }],
        confidence: { level: 'high', why: 'Consistent' },
        openQuestions: ['Other planets'],
      },
      findings,
      sources,
      droppedPoints: 1,
      droppedFindings: 1,
    })
    expect(cited.map((s) => [s.n, s.url])).toEqual([
      [1, 'https://b.test/'],
      [2, 'https://a.test/'],
    ])
    expect(markdown).toContain('- Scattering [1]')
    expect(markdown).toContain('- Short waves scatter [2]')
    expect(markdown).toContain('- Both [1][2]')
    expect(markdown).toContain('> **Sources disagree:** They differ on degree [1][2]')
    expect(markdown).toContain('## Confidence and open questions')
    expect(markdown).toContain('1 finding left out because the quote couldn')
    expect(markdown).toContain('1. [Source B](https://b.test/), accessed 2026-11-12')
    // Every [n] in the text is a listed source.
    const used = new Set([...markdown.matchAll(/\[(\d+)\](?!\()/g)].map((m) => Number(m[1])))
    expect([...used].every((n) => cited.some((s) => s.n === n))).toBe(true)
    expect(summary).toBe('Scattering [1]')
    expect(markdown).not.toContain('Partial report')
  })

  it('says it’s partial, and why', () => {
    const { markdown } = writeReport({
      question: 'Q',
      synthesis: plainSynthesis(['Sub one', 'Sub two'], findings),
      findings,
      sources,
      partial: 'You stopped it.',
      droppedPoints: 0,
      droppedFindings: 0,
    })
    expect(markdown).toContain('> **Partial report.** You stopped it.')
    expect(markdown).toContain('## Sub one')
    expect(markdown).toContain('- Claim F1 [1]')
    expect(markdown).toContain('- Sub two')
  })
})

describe('plans and limits', () => {
  it('keeps at most eight distinct one-line sub-questions', () => {
    const many = Array.from({ length: 12 }, (_, i) => `Q${i}`)
    expect(checkPlan({ subQuestions: [...many, 'Q1'], sources: ['docs'] })?.subQuestions).toHaveLength(8)
    expect(checkPlan({ subQuestions: [] })).toBeUndefined()
    expect(planFromText('1. First\n- Second\n\n* Third')?.subQuestions).toEqual(['First', 'Second', 'Third'])
  })

  it('caps workers and sources by the user’s settings, or by depth', () => {
    expect(limitsFor('standard', { workers: 0, sources: 0 })).toEqual({ parallel: 3, workers: 10, sources: 30, rounds: 1 })
    expect(limitsFor('thorough', { workers: 2, sources: 5 })).toEqual({ parallel: 2, workers: 2, sources: 5, rounds: 2 })
  })

  it('reads JSON in a code fence', () => {
    expect(parseJson('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
})
