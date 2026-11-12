import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { blockedWhy, checkMode, folderLines, modeOf, placeAccess, placesOf, refusedEditWhy } from './folder-modes.ts'
import { localMachine } from './machine.ts'
import type { ContextItem } from './shared.ts'
import { cantSandbox, needs } from './test-env.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-folder-modes-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const home = join(root, 'home')
const garage = join(home, 'Library', 'Application Support', 'Kothar')
mkdirSync(join(home, '.ssh'), { recursive: true })
mkdirSync(join(garage, 'accounts'), { recursive: true })

const folder = (path: string, more: Partial<ContextItem> = {}): ContextItem => ({
  section: 'folders',
  path,
  from: 'space',
  enabled: true,
  text: '',
  mode: 'edit',
  ...more,
})

describe('modeOf', () => {
  it("takes the nearest chat's pick, then Edit in place", () => {
    const space = { folderModes: { '/a': 'readOnly' as const } }
    const worker = { folderModes: { '/a': 'edit' as const, '/b': 'readOnly' as const } }
    expect(modeOf([{}, space], '/a')).toBe('readOnly')
    expect(modeOf([worker, space], '/a')).toBe('edit')
    expect(modeOf([worker, space], '/b')).toBe('readOnly')
    expect(modeOf([{}, {}], '/c')).toBe('edit')
  })

  it('checks a mode from the UI', () => {
    expect(checkMode('readOnly')).toBe('readOnly')
    expect(() => checkMode('anything')).toThrow('Unknown folder mode')
  })
})

describe('blockedWhy', () => {
  it("blocks the garage, folders in it and folders holding it, nothing else", () => {
    expect(blockedWhy(garage, garage)).toContain("Kothar's own data")
    expect(blockedWhy(join(garage, 'chats'), garage)).toBeDefined()
    expect(blockedWhy(home, garage)).toBeDefined()
    expect(blockedWhy(join(home, 'code'), garage)).toBeUndefined()
  })
})

describe('placesOf', () => {
  it('keeps folders that are on and not git, and makes a blocked one read only', () => {
    const items = [
      folder('/a'),
      folder('/repo', { git: true, mode: undefined }),
      folder('/off', { enabled: false }),
      folder('/held', { blocked: 'why' }),
      { ...folder('/f.md'), section: 'files' as const },
    ]
    expect(placesOf(items)).toEqual([
      { path: '/a', mode: 'edit' },
      { path: '/held', mode: 'readOnly', blocked: 'why' },
    ])
  })
})

describe('placeAccess', () => {
  it('makes folders edited in place writable, keeping keys inside them read only', () => {
    const code = join(home, 'code')
    const places = [
      { path: code, mode: 'edit' as const },
      { path: home, mode: 'edit' as const },
      { path: '/ref', mode: 'readOnly' as const },
    ]
    const { writable, readOnly } = placeAccess(places, home, garage)
    expect(writable).toEqual([code, home])
    expect(readOnly).toContain(join(home, '.ssh'))
    expect(readOnly).toContain(join(garage, 'accounts'))
    expect(placeAccess([{ path: code, mode: 'edit' }], home, garage).readOnly).toEqual([])
  })
})

describe('what agents are told', () => {
  it('lists each folder with where to write', () => {
    expect(
      folderLines([
        { path: '/a', mode: 'edit' },
        { path: '/b', mode: 'readOnly' },
      ]),
    ).toEqual(['- /a: Edit in place. Write in it directly.', '- /b: Read only.'])
    expect(folderLines([{ path: '/c', mode: 'copy', where: '/work/c' }])).toEqual([
      '- /c: Work on a copy. Write only in your copy at /work/c; the user copies your changes back.',
    ])
  })

  it('points an edit in a folder set to Work on a copy at the copy', () => {
    const message = refusedEditWhy('/c/x', '/work', [{ path: '/c', mode: 'copy', where: '/work/c' }], 'ADVICE')
    expect(message).toBe('Kothar lets this chat edit only inside /work. /c is set to Work on a copy: edit your copy at /work/c instead.')
  })

  it('names the mode setting when an edit in a Read only folder is refused', () => {
    const message = refusedEditWhy('/b/x', '/work', [{ path: '/b', mode: 'readOnly' }], 'ADVICE')
    expect(message).toBe(
      "Kothar lets this chat edit only inside /work. /b is set to Read only. Work in the work folder, or ask the user to set the folder to Edit in place (its mode in the chat's Context panel).",
    )
    expect(refusedEditWhy('/elsewhere/x', '/work', [], 'ADVICE')).toBe('Kothar lets this chat edit only inside /work. ADVICE')
  })
})

describe.skipIf(process.platform !== 'darwin')('a folder edited in place, in the real sandbox', () => {
  beforeEach((context) => needs(context, cantSandbox))

  it('lets a sandboxed process write in the folder but not the keys inside it or elsewhere', async () => {
    const work = join(root, 'work')
    const other = join(root, 'other')
    for (const dir of [work, other]) mkdirSync(dir, { recursive: true })
    const { writable, readOnly } = placeAccess([{ path: home, mode: 'edit' }], home, garage)
    const paths = [join(home, 'notes.md'), join(home, '.ssh', 'config'), join(other, 'x'), join(work, 'y')]
    const script = `const fs = require('node:fs'); console.log(JSON.stringify(${JSON.stringify(paths)}.map((p) => {
      try { fs.writeFileSync(p, 'x'); return 'ok' } catch (e) { return e.code } })))`
    const sandbox = { writable: [work, ...writable], readOnly }
    const { stdout, stderr } = await localMachine.run(process.execPath, ['-e', script], { cwd: work, sandbox })
    if (!stdout) throw new Error(stderr)
    expect(JSON.parse(stdout)).toEqual(['ok', 'EPERM', 'EPERM', 'ok'])
  })
})
