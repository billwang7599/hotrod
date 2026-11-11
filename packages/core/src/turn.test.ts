import { describe, expect, it } from 'vitest'
import type { Checkout } from './checkouts.ts'
import { sessionPlaceOf } from './turn.ts'

const checkout = (folder: string, path: string): Checkout => ({
  folder,
  worktree: { path, branch: `kothar/${folder.slice(1)}` },
  writable: [`${folder}/.git`],
  readOnly: [`${folder}/.git/config`],
})

describe('sessionPlaceOf', () => {
  const plan = {
    workDir: '/work/s',
    parts: { extensions: [], memory: [], items: [] },
    attachmentsDir: '/garage/chats/s/attachments-that-do-not-exist',
    folders: ['/repo', '/notes'],
    repos: ['/repo'],
    places: [{ path: '/notes', mode: 'edit' as const }],
    sandbox: { writable: ['/work/s'], tmpDir: '/work/s/.tmp' },
  }

  it('runs in the first checkout and reaches the work folder, the other checkouts and plain folders', () => {
    const place = sessionPlaceOf(plan, [checkout('/repo', '/work/s/repo'), checkout('/other', '/work/s/other')])
    expect(place.cwd).toBe('/work/s/repo')
    expect(place.extraDirs).toEqual(['/work/s', '/work/s/other', '/notes'])
    expect(place.jail).toEqual({
      writable: ['/work/s', '/repo/.git', '/other/.git'],
      tmpDir: '/work/s/.tmp',
      readOnly: ['/repo/.git/config', '/other/.git/config'],
    })
    expect(place.instructions).toContain('Your work folder: /work/s')
    expect(place.instructions).toContain('- /repo: /work/s/repo (branch kothar/repo)')
    expect(place.instructions).toContain('- /notes: Edit in place. Write in it directly.')
    expect(place.folderPlaces).toEqual([
      { path: '/notes', mode: 'edit' },
      { path: '/repo', mode: 'checkout', where: '/work/s/repo' },
      { path: '/other', mode: 'checkout', where: '/work/s/other' },
    ])
  })

  it('keeps the plan sandbox read-only paths after the checkouts', () => {
    const sandbox = { ...plan.sandbox, readOnly: ['/notes/.ssh'] }
    const place = sessionPlaceOf({ ...plan, sandbox }, [checkout('/repo', '/work/s/repo')])
    expect(place.jail?.readOnly).toEqual(['/notes/.ssh', '/repo/.git/config'])
  })

  it('runs in the work folder without checkouts, and has no sandbox when the plan has none', () => {
    const place = sessionPlaceOf({ ...plan, sandbox: undefined }, [])
    expect(place.cwd).toBe('/work/s')
    expect(place.extraDirs).toEqual(['/notes'])
    expect(place.jail).toBeUndefined()
    expect(place.instructions).not.toContain('Your work folder')
  })
})
