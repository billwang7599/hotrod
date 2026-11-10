import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionPanel } from '@kothar/extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadExtensions, panelTabOf } from './extensions.ts'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function extensionsDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'kothar-extensions-'))
  dirs.push(dir)
  for (const [id, source] of Object.entries(files)) {
    mkdirSync(join(dir, id))
    writeFileSync(join(dir, id, 'index.ts'), source)
  }
  return dir
}

const declare = (id: string, extra = '') =>
  `export default { id: '${id}', name: 'Extension ${id}', description: '', enabledByDefault: true${extra} }`

it("loads each folder's index.ts in name order, listing a broken extension under its folder with why", async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const dir = extensionsDir({
    beta: declare('beta'),
    alpha: `import type { Extension } from '@kothar/extension-api'\nconst extension: Extension = ${declare('alpha').slice(15)}\nexport default extension`,
    throws: `throw new Error('boom')`,
    'no-default': `export const extension = 1`,
    renamed: declare('other'),
    reserved: declare('reserved', `, settings: [{ key: 'enabled', label: 'On', type: 'boolean', default: true }]`),
  })
  mkdirSync(join(dir, 'empty'))
  writeFileSync(join(dir, 'tsconfig.json'), '{}')

  const { extensions, brokenExtensions } = await loadExtensions(dir)
  expect(extensions.map((extension) => extension.id)).toEqual(['alpha', 'beta'])
  expect(brokenExtensions).toEqual([
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

it('says which package an extension is missing and how to install it', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const dir = extensionsDir({
    imports: `import '@kothar-test/absent-package'\n${declare('imports')}`,
    resolves: `import { createRequire } from 'node:module'\ncreateRequire(import.meta.url).resolve('absent-package/package.json')\n${declare('resolves')}`,
  })
  const install = 'Run npm install in the Kothar folder, then restart Kothar.'
  expect((await loadExtensions(dir)).brokenExtensions).toEqual([
    { id: 'imports', loadError: `@kothar-test/absent-package isn't installed. ${install}` },
    { id: 'resolves', loadError: `absent-package isn't installed. ${install}` },
  ])
})

it('finds no extensions in a missing folder', async () => {
  expect(await loadExtensions(join(tmpdir(), 'kothar-no-such-extensions'))).toEqual({ extensions: [], brokenExtensions: [] })
})

describe('panelTabOf', () => {
  it("passes on a panel's placement, keys and sidebar entry, and nothing of the wrong kind", () => {
    const render = () => ({ type: 'empty' as const, text: '' })
    expect(panelTabOf('notes', { id: 'n', title: 'Notes', placement: 'popup', shortcut: ' Mod+Shift+N ', sidebar: true, render })).toEqual({
      extension: 'notes',
      id: 'n',
      title: 'Notes',
      placement: 'popup',
      shortcut: 'Mod+Shift+N',
      sidebar: true,
    })
    const odd = { id: 'g', title: 'Git', placement: 'window', shortcut: 4, sidebar: 'yes', render } as unknown as ExtensionPanel
    expect(panelTabOf('git', odd)).toEqual({ extension: 'git', id: 'g', title: 'Git' })
  })
})
