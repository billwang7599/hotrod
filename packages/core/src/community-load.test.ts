import type { Extension, ExtensionManifest } from '@kothar/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { gatherExtensions } from './community-load.ts'
import type { CommunityExtension } from './extensions.ts'

const builtIn = (id: string, change: Partial<Extension> = {}): Extension => ({ id, name: id, description: '', enabledByDefault: true, ...change })
const tool = (name: string) => ({ name, description: '', inputSchema: { type: 'object' as const }, offered: () => true, run: async () => '' })

const found = (id: string, extension?: Extension): CommunityExtension => {
  const manifest: ExtensionManifest = { id, name: `Extension ${id}`, version: '1.0.0', author: 'a', description: 'd', api: 1, uses: [] }
  return { manifest, dir: `/x/${id}`, item: { kind: 'extension', id, name: manifest.name, version: '1.0.0', source: 'local' }, ...(extension && { extension }) }
}

describe('gatherExtensions', () => {
  it('throws when two built-in extensions share an id, a chat or a tool', () => {
    expect(() => gatherExtensions([builtIn('a'), builtIn('a')], [])).toThrow('Two extensions have the id "a"')
    const chat = { id: 'c', name: 'C', instructions: '' }
    expect(() => gatherExtensions([builtIn('a', { chats: [chat] }), builtIn('b', { chats: [chat] })], [])).toThrow('Two extension chats')
    expect(() => gatherExtensions([builtIn('a', { tools: [tool('t')] }), builtIn('b', { tools: [tool('t')] })], [])).toThrow('Two tools')
  })

  it('skips a community extension with a taken id and stubs one whose tool is taken', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const set = gatherExtensions(
      [builtIn('a', { tools: [tool('t')] })],
      [found('a', builtIn('a')), found('b', builtIn('b', { tools: [tool('t')] })), found('c', builtIn('c'))],
    )
    expect(set.extensions.map((e) => e.id)).toEqual(['a', 'b', 'c'])
    expect(set.extensions[1]!.tools).toBeUndefined()
    expect(set.community.get('b')).toMatchObject({ loadError: 'its tool or chat "t" is already taken' })
    expect(set.community.get('c')).toMatchObject({ running: '1.0.0' })
    expect([...set.imported.keys()]).toEqual(['b', 'c'])
    expect(set.builtInIds).toEqual(new Set(['a']))
    vi.restoreAllMocks()
  })
})
