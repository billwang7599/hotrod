import { mkdirSync, mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { moveCommunityDir, moveExtensionsDir, renameChatFile, renameEntry, renameSettings } from './vocab-move.ts'

describe('the subagents-to-workers move', () => {
  it('renames the extension and model list in settings, flat or per engine, and keeps a new name already there', () => {
    const settings = {
      extensions: { subagents: { enabled: false }, home: { enabled: true } },
      models: { chat: [], subagents: [{ engine: 'fake', model: 'a' }] },
    }
    expect(renameSettings(settings)).toBe(true)
    expect(settings).toEqual({
      extensions: { workers: { enabled: false }, home: { enabled: true } },
      models: { chat: [], workers: [{ engine: 'fake', model: 'a' }] },
    })
    expect(renameSettings(settings)).toBe(false)
    const perEngine = { models: { fake: { subagents: ['a'] } } }
    expect(renameSettings(perEngine)).toBe(true)
    expect(perEngine).toEqual({ models: { fake: { workers: ['a'] } } })
    const both = { extensions: { subagents: { limit: 1 }, workers: { limit: 2 } } }
    renameSettings(both)
    expect(both).toEqual({ extensions: { workers: { limit: 2 } } })
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

  it('moves the community extensions folder from aftermarket once, never over one already there', () => {
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

describe('the mods-to-extensions move', () => {
  it('renames the extensions, the community switch and the settings versions in settings, then subagents in them', () => {
    const settings: Record<string, unknown> = {
      mods: { subagents: { limit: 3 }, home: { enabled: false } },
      communityMods: true,
      modVersions: { memory: 2 },
      editAnywhere: true,
    }
    expect(renameSettings(settings)).toBe(true)
    expect(settings).toEqual({
      extensions: { workers: { limit: 3 }, home: { enabled: false } },
      communityExtensions: true,
      extensionVersions: { memory: 2 },
      editAnywhere: true,
    })
    expect(renameSettings(settings)).toBe(false)
    // A new name already there wins.
    const both = { mods: { home: { enabled: false } }, extensions: { home: { enabled: true } } }
    renameSettings(both)
    expect(both).toEqual({ extensions: { home: { enabled: true } } })
  })

  it("reads an old chat.json's owning extension and space values, and an old note, under the new names", () => {
    expect(renameChatFile({ id: 'main', mod: 'home', modValues: { git: { cleanup: true } } })).toEqual({
      id: 'main',
      extension: 'home',
      extensionValues: { git: { cleanup: true } },
    })
    expect(renameEntry({ at: 'x', type: 'mod.note', text: 'hi', mod: 'git', panel: 'changes' })).toEqual({
      at: 'x',
      type: 'extension.note',
      text: 'hi',
      extension: 'git',
      panel: 'changes',
    })
    expect(renameEntry({ type: 'mod.note', text: 'plain' })).toEqual({ type: 'extension.note', text: 'plain' })
  })

  it("moves each extension's own files from <garage>/mods once, never over a folder already there", () => {
    const garage = mkdtempSync(join(tmpdir(), 'kothar-vocab-'))
    mkdirSync(join(garage, 'mods', 'memory'), { recursive: true })
    writeFileSync(join(garage, 'mods', 'memory', 'state.json'), '{}')
    moveExtensionsDir(garage)
    expect(existsSync(join(garage, 'mods'))).toBe(false)
    expect(readFileSync(join(garage, 'extensions', 'memory', 'state.json'), 'utf8')).toBe('{}')
    mkdirSync(join(garage, 'mods'))
    moveExtensionsDir(garage)
    expect(existsSync(join(garage, 'mods'))).toBe(true)
  })
})
