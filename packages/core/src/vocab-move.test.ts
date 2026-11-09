import { mkdirSync, mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { moveCommunityDir, renameChatFile, renameEntry, renameSettings } from './vocab-move.ts'

describe('the subagents-to-workers move', () => {
  it('renames the mod and model list in settings, flat or per engine, and keeps a new name already there', () => {
    const settings = {
      mods: { subagents: { enabled: false }, home: { enabled: true } },
      models: { chat: [], subagents: [{ engine: 'fake', model: 'a' }] },
    }
    expect(renameSettings(settings)).toBe(true)
    expect(settings).toEqual({
      mods: { workers: { enabled: false }, home: { enabled: true } },
      models: { chat: [], workers: [{ engine: 'fake', model: 'a' }] },
    })
    expect(renameSettings(settings)).toBe(false)
    const perEngine = { models: { fake: { subagents: ['a'] } } }
    expect(renameSettings(perEngine)).toBe(true)
    expect(perEngine).toEqual({ models: { fake: { workers: ['a'] } } })
    const both = { mods: { subagents: { limit: 1 }, workers: { limit: 2 } } }
    renameSettings(both)
    expect(both).toEqual({ mods: { workers: { limit: 2 } } })
  })

  it('reads an old chat.json and log entry under the new names, leaving everything else', () => {
    expect(renameChatFile({ id: 'a', subagent: true, role: 'subagents', name: 'x' })).toEqual({
      id: 'a',
      worker: true,
      role: 'workers',
      name: 'x',
    })
    expect(renameChatFile({ id: 'b', role: 'planning' })).toEqual({ id: 'b', role: 'planning' })
    expect(renameEntry({ type: 'subagent.report', text: 'hi' })).toEqual({ type: 'worker.report', text: 'hi' })
    const message = { type: 'user.message', text: '[subagent "x" (ab12)] old' }
    expect(renameEntry(message)).toBe(message)
  })

  it('moves the community mods folder from aftermarket once, never over one already there', () => {
    const garage = mkdtempSync(join(tmpdir(), 'kothar-vocab-'))
    mkdirSync(join(garage, 'aftermarket', 'demo'), { recursive: true })
    writeFileSync(join(garage, 'aftermarket', 'demo', 'main.mjs'), 'x')
    moveCommunityDir(garage)
    expect(existsSync(join(garage, 'aftermarket'))).toBe(false)
    expect(readFileSync(join(garage, 'community', 'demo', 'main.mjs'), 'utf8')).toBe('x')
    mkdirSync(join(garage, 'aftermarket'))
    moveCommunityDir(garage)
    expect(existsSync(join(garage, 'aftermarket'))).toBe(true)
  })
})
