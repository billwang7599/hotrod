import { expect, it } from 'vitest'
import { userDataDir } from './user-data.ts'

it('a fresh install keeps its window data in Kothar Desktop', () => {
  expect(userDataDir('/AppData', () => false)).toBe('/AppData/Kothar Desktop')
})

it('window data from when Kothar was Hotrod stays in use, so UI preferences survive the rename', () => {
  expect(userDataDir('/AppData', (path) => path === '/AppData/Hotrod Desktop')).toBe('/AppData/Hotrod Desktop')
  const both = (path: string) => path.endsWith(' Desktop')
  expect(userDataDir('/AppData', both)).toBe('/AppData/Kothar Desktop')
})
