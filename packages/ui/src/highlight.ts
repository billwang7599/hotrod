import { classHighlighter, highlightTree } from '@lezer/highlight'
import type { Parser } from '@lezer/common'
import { parser as css } from '@lezer/css'
import { parser as html } from '@lezer/html'
import { parser as javascript } from '@lezer/javascript'
import { parser as json } from '@lezer/json'
import { parser as python } from '@lezer/python'

/**
 * Syntax colours for a code view (ExtensionView 'code' with a language), offline, with Lezer's parsers: each line as
 * its runs of text, each run with the classHighlighter's tok-* classes, which styles.css maps to the theme's colours.
 */
const jsx = javascript.configure({ dialect: 'jsx' })
const PARSERS: Record<string, Parser> = {
  javascript,
  js: javascript,
  mjs: javascript,
  jsx,
  typescript: javascript.configure({ dialect: 'ts' }),
  ts: javascript.configure({ dialect: 'ts' }),
  tsx: javascript.configure({ dialect: 'ts jsx' }),
  html,
  htm: html,
  svg: html,
  xml: html,
  css,
  json,
  python,
  py: python,
}

// Past this, a code view stays plain: highlighting a huge file would stall the window.
export const HIGHLIGHT_MAX_CHARS = 300_000

export type Run = { text: string; className?: string }

export const highlights = (language: string | undefined) => !!language && Object.hasOwn(PARSERS, language.toLowerCase())

/** The text's lines as runs, coloured when the language is one Kothar knows; undefined when it isn't. */
export function highlightLines(text: string, language: string | undefined): Run[][] | undefined {
  if (!highlights(language) || text.length > HIGHLIGHT_MAX_CHARS) return undefined
  const parser = PARSERS[language!.toLowerCase()]!
  const runs: Run[] = []
  let at = 0
  const plain = (to: number) => {
    if (to > at) runs.push({ text: text.slice(at, to) })
  }
  highlightTree(parser.parse(text), classHighlighter, (from, to, className) => {
    plain(from)
    runs.push({ text: text.slice(from, to), className })
    at = to
  })
  plain(text.length)
  // Split runs on line breaks, so each line draws on its own (and lines can be numbered or cut).
  const lines: Run[][] = [[]]
  for (const run of runs) {
    const parts = run.text.split('\n')
    parts.forEach((part, i) => {
      if (i > 0) lines.push([])
      if (part) lines.at(-1)!.push(run.className ? { text: part, className: run.className } : { text: part })
    })
  }
  return lines
}
