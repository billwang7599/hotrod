import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { loadMods } from './mods.ts'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function modsDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'kothar-mods-'))
  dirs.push(dir)
  for (const [id, source] of Object.entries(files)) {
    mkdirSync(join(dir, id))
    writeFileSync(join(dir, id, 'index.ts'), source)
  }
  return dir
}

const declare = (id: string, extra = '') =>
  `export default { id: '${id}', name: 'Mod ${id}', description: '', enabledByDefault: true${extra} }`

it("loads each folder's index.ts in name order, listing a broken mod under its folder with why", async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const dir = modsDir({
    beta: declare('beta'),
    alpha: `import type { Mod } from '@kothar/mod-api'\nconst mod: Mod = ${declare('alpha').slice(15)}\nexport default mod`,
    throws: `throw new Error('boom')`,
    'no-default': `export const mod = 1`,
    renamed: declare('other'),
    reserved: declare('reserved', `, settings: [{ key: 'enabled', label: 'On', type: 'boolean', default: true }]`),
  })
  mkdirSync(join(dir, 'empty'))
  writeFileSync(join(dir, 'tsconfig.json'), '{}')

  const { mods, brokenMods } = await loadMods(dir)
  expect(mods.map((mod) => mod.id)).toEqual(['alpha', 'beta'])
  expect(brokenMods).toEqual([
    { id: 'no-default', loadError: 'it has no default export' },
    { id: 'renamed', loadError: `its id "other" is not its folder's name` },
    { id: 'reserved', loadError: '"enabled" is not a setting key' },
    { id: 'throws', loadError: 'boom' },
  ])
  const reported = errors.mock.calls.map(([message]) => String(message))
  expect(reported).toHaveLength(4)
  for (const id of ['throws', 'no-default', 'renamed', 'reserved']) {
    expect(reported.some((message) => message.includes(join(dir, id)))).toBe(true)
  }
  expect(reported.find((message) => message.includes('throws'))).toContain('boom')
})

it('says which package a mod is missing and how to install it', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const dir = modsDir({
    imports: `import '@kothar-test/absent-package'\n${declare('imports')}`,
    resolves: `import { createRequire } from 'node:module'\ncreateRequire(import.meta.url).resolve('absent-package/package.json')\n${declare('resolves')}`,
  })
  const install = 'Run npm install in the Kothar folder, then restart Kothar.'
  expect((await loadMods(dir)).brokenMods).toEqual([
    { id: 'imports', loadError: `@kothar-test/absent-package isn't installed. ${install}` },
    { id: 'resolves', loadError: `absent-package isn't installed. ${install}` },
  ])
})

it('finds no mods in a missing folder', async () => {
  expect(await loadMods(join(tmpdir(), 'kothar-no-such-mods'))).toEqual({ mods: [], brokenMods: [] })
})
