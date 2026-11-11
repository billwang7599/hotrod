import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { COPIES_FILE, openFolderCopies } from './folder-copies.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-copies-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0

function fixture() {
  const base = join(root, `case-${++n}`)
  const folder = join(base, 'notes')
  const work = join(base, 'work')
  const space = { dir: join(base, 'chat'), info: { id: `s${n}` } }
  for (const dir of [join(folder, 'sub'), join(folder, 'node_modules', 'x'), join(folder, '.git'), work, space.dir]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(folder, 'a.md'), 'A')
  writeFileSync(join(folder, 'sub', 'b.md'), 'B')
  writeFileSync(join(folder, 'gone.md'), 'G')
  writeFileSync(join(folder, 'node_modules', 'x', 'index.js'), 'dep')
  writeFileSync(join(folder, '.git', 'HEAD'), 'ref')
  symlinkSync('/etc/hosts', join(folder, 'link'))
  const copies = openFolderCopies<typeof space>({ now: () => new Date('2026-11-11T00:00:00.000Z') })
  return { folder, work, space, copies }
}

describe('a folder set to Work on a copy', () => {
  it('is copied once into the work folder, leaving out node_modules, .git and symlinks', async () => {
    const { folder, work, space, copies } = fixture()
    const copy = await copies.copyOf(space, folder, work)
    expect(copy.path).toBe(join(work, 'notes'))
    expect(readFileSync(join(copy.path, 'sub', 'b.md'), 'utf8')).toBe('B')
    for (const left of ['node_modules', '.git', 'link']) expect(existsSync(join(copy.path, left))).toBe(false)
    expect(Object.keys(copy.files).toSorted()).toEqual(['a.md', 'gone.md', 'sub/b.md'])
    expect(JSON.parse(readFileSync(join(space.dir, COPIES_FILE), 'utf8'))[folder].madeAt).toBe('2026-11-11T00:00:00.000Z')

    writeFileSync(join(copy.path, 'a.md'), 'edited')
    const again = await copies.copyOf(space, folder, work)
    expect(again.path).toBe(copy.path)
    expect(readFileSync(join(copy.path, 'a.md'), 'utf8')).toBe('edited')
  })

  it('takes a free name beside a checkout or folder already there', async () => {
    const { folder, work, space, copies } = fixture()
    mkdirSync(join(work, 'notes'))
    expect((await copies.copyOf(space, folder, work)).path).toBe(join(work, 'notes-2'))
  })

  it('lists added, changed and deleted files, and which originals changed since', async () => {
    const { folder, work, space, copies } = fixture()
    const { path } = await copies.copyOf(space, folder, work)
    writeFileSync(join(path, 'a.md'), 'A2')
    writeFileSync(join(path, 'new.md'), 'N')
    rmSync(join(path, 'gone.md'))
    writeFileSync(join(path, 'sub', 'b.md'), 'B2')
    writeFileSync(join(folder, 'sub', 'b.md'), 'B by the user')
    expect((await copies.changesOf(space, folder)).changes).toEqual([
      { path: 'a.md', kind: 'changed' },
      { path: 'gone.md', kind: 'deleted' },
      { path: 'new.md', kind: 'added' },
      { path: 'sub/b.md', kind: 'changed', conflict: true },
    ])
  })

  it('copies the picked changes back, then counts them as the starting point', async () => {
    const { folder, work, space, copies } = fixture()
    const { path } = await copies.copyOf(space, folder, work)
    writeFileSync(join(path, 'a.md'), 'A2')
    writeFileSync(join(path, 'sub', 'new.md'), 'N')
    rmSync(join(path, 'gone.md'))
    expect(await copies.copyBack(space, folder, ['a.md', 'sub/new.md', 'gone.md'], false)).toBe(3)
    expect(readFileSync(join(folder, 'a.md'), 'utf8')).toBe('A2')
    expect(readFileSync(join(folder, 'sub', 'new.md'), 'utf8')).toBe('N')
    expect(existsSync(join(folder, 'gone.md'))).toBe(false)
    expect((await copies.changesOf(space, folder)).changes).toEqual([])
  })

  it('refuses to overwrite an original that changed since, writing nothing, unless the user confirms', async () => {
    const { folder, work, space, copies } = fixture()
    const { path } = await copies.copyOf(space, folder, work)
    writeFileSync(join(path, 'a.md'), 'agent')
    writeFileSync(join(path, 'sub', 'b.md'), 'agent')
    writeFileSync(join(folder, 'a.md'), 'user')
    await expect(copies.copyBack(space, folder, ['a.md', 'sub/b.md'], false)).rejects.toThrow('a.md')
    expect(readFileSync(join(folder, 'a.md'), 'utf8')).toBe('user')
    expect(readFileSync(join(folder, 'sub', 'b.md'), 'utf8')).toBe('B')
    expect(await copies.copyBack(space, folder, ['a.md'], true)).toBe(1)
    expect(readFileSync(join(folder, 'a.md'), 'utf8')).toBe('agent')
  })

  it('refuses files that did not change, and anything but a list of paths', async () => {
    const { folder, work, space, copies } = fixture()
    await copies.copyOf(space, folder, work)
    await expect(copies.copyBack(space, folder, ['../escape'], true)).rejects.toThrow('Not changed in the copy')
    await expect(copies.copyBack(space, folder, 'a.md', true)).rejects.toThrow('Pick the files')
    await expect(copies.changesOf(space, join(root, 'nothing'))).rejects.toThrow('has no copy')
  })
})
