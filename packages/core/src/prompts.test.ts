import type { Extension } from '@kothar/extension-api'
import { describe, expect, it } from 'vitest'
import type { Settings } from './chat-store.ts'
import { instructionSections, buildInstructions } from './instructions.ts'
import { seededParts, seededPrompt } from './memory.ts'
import { declaredPrompts, openPrompts } from './prompts.ts'

const extension = (text: string): Extension => ({
  id: 'ext',
  name: 'Ext',
  description: '',
  enabledByDefault: true,
  prompts: [{ id: 'rule', label: 'The rule', text, where: 'instructions' }],
})

describe('named prompts', () => {
  it('marks an edit made against an older default as Updated default, until it is reset', () => {
    const settings: Settings = { engines: {} } as Settings
    let saves = 0
    const prompts = openPrompts({ settings, saveSettings: () => saves++, changed: () => {} })
    prompts.set(extension('Old default.'), 'rule', 'Mine.')
    expect(settings.prompts).toEqual({ ext: { rule: { text: 'Mine.', base: 'Old default.' } } })
    expect(prompts.infoOf(extension('Old default.'))[0]).toMatchObject({ edited: true, text: 'Mine.' })
    expect(prompts.infoOf(extension('Old default.'))[0]).not.toHaveProperty('updatedDefault')
    // An update changed the default: the edit stays, marked.
    const updated = extension('New default.')
    expect(prompts.infoOf(updated)[0]).toMatchObject({ edited: true, updatedDefault: true, text: 'Mine.', default: 'New default.' })
    expect(prompts.textOf(updated, 'rule')).toBe('Mine.')
    prompts.set(updated, 'rule', undefined)
    expect(prompts.textOf(updated, 'rule')).toBe('New default.')
    expect(settings.prompts).toBeUndefined()
    expect(saves).toBe(2)
  })

  it('refuses an unknown prompt and an over-long text, and skips badly declared ones', () => {
    const prompts = openPrompts({ settings: { engines: {} } as Settings, saveSettings: () => {}, changed: () => {} })
    expect(() => prompts.set(extension('x'), 'nope', 'y')).toThrow('Ext has no prompt "nope"')
    expect(() => prompts.textOf(extension('x'), 'nope')).toThrow()
    expect(() => prompts.set(extension('x'), 'rule', 'y'.repeat(100_001))).toThrow('at most')
    const messy = {
      ...extension('x'),
      prompts: [
        { id: 'Bad Id', label: 'x', text: 'x', where: 'instructions' },
        { id: 'ok', label: 'Ok', text: 'x', where: 'instructions' },
        { id: 'ok', label: 'Twice', text: 'x', where: 'instructions' },
        { id: 'where', label: 'x', text: 'x', where: 'somewhere' },
      ],
    } as unknown as Extension
    expect(declaredPrompts(messy).map((p) => p.label)).toEqual(['Ok'])
  })
})

describe('sections of what is sent', () => {
  it('label each part of the instructions, and join to exactly what buildInstructions makes', () => {
    const parts = {
      role: 'ROLE',
      workDir: '/w',
      checkouts: [{ folder: '/a', path: '/w/a', branch: 'b' }],
      folders: [{ path: '/docs', mode: 'edit' as const }],
      extensions: ['ONE', 'TWO'],
      workers: 'WORKERS',
      memory: ['MEMORY'],
      parentView: 'VIEW',
      setup: { name: 'Review', instructions: 'SETUP' },
      items: [{ section: 'files' as const, path: '/a/x.md', from: 'chat' as const, enabled: true, text: 'X' }],
      sources: { extensions: ['one', 'two'], memory: 'memory', role: 'home' },
    }
    const sections = instructionSections(parts)
    expect(sections.map((s) => s.text).join('\n\n')).toBe(buildInstructions(parts))
    expect(sections.map((s) => [s.source, s.label, s.extension])).toEqual([
      ['extension', 'Role of this chat', 'home'],
      ['core', 'Where you can write', undefined],
      ['core', 'Git checkouts', undefined],
      ['core', 'Folder modes', undefined],
      ['extension', 'Instructions', 'one'],
      ['extension', 'Instructions', 'two'],
      ['extension', 'When to start workers', 'workers'],
      ['extension', 'How to read the memory', 'memory'],
      ['core', "Parent chat's memory at launch", undefined],
      ['context', 'Setup "Review"', undefined],
      ['context', 'File: /a/x.md', undefined],
    ])
  })

  it('split the prompt into the memory, reports and your message, joining to the prompt', () => {
    const report = { text: 'Done', report: { chatId: 'w', name: 'Worker' } }
    for (const [view, message, reports] of [
      ['', 'hi', []],
      ['VIEW', 'hi', []],
      ['VIEW', 'hi', [report]],
      ['', '', [report]],
    ] as const) {
      const parts = seededParts(view, message, [...reports])
      expect(parts.map((p) => p.text).join('\n\n')).toBe(seededPrompt(view, message, [...reports]))
    }
    expect(seededParts('VIEW', 'hi', [report]).map((p) => p.kind)).toEqual(['view', 'report', 'message'])
  })
})
