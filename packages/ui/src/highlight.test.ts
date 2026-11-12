import { expect, test } from 'vitest'
import { HIGHLIGHT_MAX_CHARS, highlightLines, highlights } from './highlight.ts'

const classesOf = (lines: ReturnType<typeof highlightLines>, word: string) =>
  lines!.flat().find((run) => run.text === word)?.className

test('colours a language Kothar knows, line by line, keeping every character', () => {
  const code = 'const answer: number = 42 // the answer\nexport default function App() {\n  return <p className="x">Hi</p>\n}'
  const lines = highlightLines(code, 'tsx')!
  expect(lines).toHaveLength(4)
  expect(lines.map((line) => line.map((run) => run.text).join('')).join('\n')).toBe(code)
  expect(classesOf(lines, 'const')).toContain('tok-keyword')
  expect(classesOf(lines, '42')).toContain('tok-number')
  expect(classesOf(lines, '// the answer')).toContain('tok-comment')
  expect(classesOf(lines, '"x"')).toContain('tok-string')
})

test('knows the usual names for each language, and leaves others, and huge texts, plain', () => {
  for (const language of ['js', 'JavaScript', 'ts', 'jsx', 'html', 'svg', 'css', 'json', 'py']) expect(highlights(language)).toBe(true)
  expect(highlightLines('fn main() {}', 'rust')).toBeUndefined()
  expect(highlightLines('x', undefined)).toBeUndefined()
  expect(highlightLines('a'.repeat(HIGHLIGHT_MAX_CHARS + 1), 'js')).toBeUndefined()
  expect(classesOf(highlightLines('<svg width="4"></svg>', 'svg'), 'svg')).toContain('tok-typeName')
  expect(classesOf(highlightLines('def f():\n  pass', 'python'), 'def')).toContain('tok-keyword')
})
