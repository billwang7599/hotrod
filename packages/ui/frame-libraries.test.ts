import { expect, test } from 'vitest'
import { FRAME_LIBRARIES as SERVED } from './frame-libraries.ts'
import { FRAME_LIBRARIES as ALLOWED } from './src/html-frame.tsx'

// The frame's policy allows what the build serves, no more and no less.
test('the libraries the frame allows are the ones Kothar builds and serves', () => {
  expect([...ALLOWED]).toEqual([...SERVED])
})

test('each library builds offline into one script', async () => {
  const { frameLibrary } = await import('./frame-libraries.ts')
  const react = await frameLibrary('react')
  expect(react).toContain('text/jsx')
  expect(react).not.toMatch(/\bimport\s*\(|\brequire\("react"\)/)
  expect(await frameLibrary('mermaid')).toContain('securityLevel')
  expect((await frameLibrary('tailwind')).length).toBeGreaterThan(10_000)
}, 60_000)
