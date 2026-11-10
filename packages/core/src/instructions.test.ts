import { describe, expect, it } from 'vitest'
import { buildInstructions, CHECKOUT_RULES, contextTextOf, type InstructionParts, WRITE_RULES } from './instructions.ts'
import type { ContextItem } from './shared.ts'

const item = (section: ContextItem['section'], path: string, text: string, more: Partial<ContextItem> = {}): ContextItem => ({
  section,
  path,
  from: 'chat',
  enabled: true,
  text,
  ...more,
})

const EMPTY: InstructionParts = { checkouts: [], extensions: [], memory: [], items: [] }

describe('buildInstructions', () => {
  it('joins every part in order: role, rules, extensions, memory, setup, context items', () => {
    const instructions = buildInstructions({
      role: 'ROLE',
      workDir: '/work/space',
      checkouts: [
        { folder: '/code/a', path: '/work/space/a', branch: 'space/a' },
        { folder: '/code/b', path: '/work/space/b', branch: 'space/b' },
      ],
      extensions: ['EXTENSION ONE', 'EXTENSION TWO'],
      workers: 'WORKERS',
      memory: ['MEMORY'],
      parentView: 'PARENT VIEW',
      setup: { name: 'Review', instructions: 'SETUP' },
      items: [item('agents', '/garage/AGENTS.md', 'GLOBAL\n'), item('files', '/code/a/notes.md', 'FILE\n\n')],
    })
    expect(instructions.split('\n\n')).toEqual([
      'ROLE',
      `${WRITE_RULES}\nYour work folder: /work/space`,
      `${CHECKOUT_RULES}\n- /code/a: /work/space/a (branch space/a)\n- /code/b: /work/space/b (branch space/b)`,
      'EXTENSION ONE',
      'EXTENSION TWO',
      'WORKERS',
      'MEMORY',
      "Your parent chat's memory when it started you:",
      'PARENT VIEW',
      'Instructions from the setup "Review":',
      'SETUP',
      'GLOBAL',
      '<file path="/code/a/notes.md">\nFILE\n</file>',
    ])
  })

  it('leaves out what is absent', () => {
    expect(buildInstructions(EMPTY)).toBe('')
    expect(buildInstructions({ ...EMPTY, role: '', parentView: '', setup: { name: 'Plain' } })).toBe('')
    expect(buildInstructions({ ...EMPTY, items: [item('agents', '/c/AGENTS.md', 'RULES')] })).toBe('RULES')
  })

  it('keeps the workers instructions even when empty, as before', () => {
    expect(buildInstructions({ ...EMPTY, workers: '', memory: ['MEMORY'] })).toBe('\n\nMEMORY')
  })
})

describe('contextTextOf', () => {
  it('skips switched-off and blank items, notes binary files and tags pasted files', () => {
    expect(
      contextTextOf([
        item('agents', '/c/AGENTS.md', '  RULES  '),
        item('agents', '/c/off.md', 'OFF', { enabled: false }),
        item('files', '/c/blank.md', '  \n'),
        item('files', '/c/logo.png', '', { binary: true }),
      ]),
    ).toEqual([
      'RULES',
      "The file /c/logo.png is not text, so it isn't pasted here. Open it with your tools when you need it.",
    ])
  })
})
