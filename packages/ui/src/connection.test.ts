import { expect, test } from 'vitest'
import { coreUrl } from './connection.ts'

const page = { protocol: 'http:', host: '127.0.0.1:5000' }

test('a built UI connects to the host that served it', () => {
  expect(coreUrl({ DEV: false }, page)).toBe('ws://127.0.0.1:5000')
  expect(coreUrl({ DEV: false }, { protocol: 'https:', host: 'example.test' })).toBe('wss://example.test')
})

test('the dev server connects to the default core port', () => {
  expect(coreUrl({ DEV: true }, { protocol: 'http:', host: 'localhost:4318' })).toBe('ws://127.0.0.1:4317')
})

test('VITE_HOTROD_CORE_URL wins in dev and in a build', () => {
  const env = { VITE_HOTROD_CORE_URL: 'ws://127.0.0.1:4461' }
  expect(coreUrl({ ...env, DEV: true }, page)).toBe('ws://127.0.0.1:4461')
  expect(coreUrl({ ...env, DEV: false }, page)).toBe('ws://127.0.0.1:4461')
})
