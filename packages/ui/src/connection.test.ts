import { expect, test } from 'vitest'
import { coreUrl, readToken } from './connection.ts'

const page = { protocol: 'http:', host: '127.0.0.1:5000' }

test('a built UI connects to the host that served it', () => {
  expect(coreUrl({ DEV: false }, page, 't')).toBe('ws://127.0.0.1:5000/?token=t')
  expect(coreUrl({ DEV: false }, { protocol: 'https:', host: 'example.test' }, 't')).toBe('wss://example.test/?token=t')
})

test('the dev server connects to the default core port', () => {
  expect(coreUrl({ DEV: true }, { protocol: 'http:', host: 'localhost:4318' }, 't')).toBe('ws://127.0.0.1:4317/?token=t')
})

test('VITE_HOTROD_CORE_URL wins in dev and in a build', () => {
  const env = { VITE_HOTROD_CORE_URL: 'ws://127.0.0.1:4461' }
  expect(coreUrl({ ...env, DEV: true }, page, 't')).toBe('ws://127.0.0.1:4461/?token=t')
  expect(coreUrl({ ...env, DEV: false }, page, 't')).toBe('ws://127.0.0.1:4461/?token=t')
})

test('the token is escaped in the URL', () => {
  expect(coreUrl({ DEV: false }, page, 'a+b/c=')).toBe('ws://127.0.0.1:5000/?token=a%2Bb%2Fc%3D')
})

function memoryStorage() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) }
}

test('the token comes from the link, then survives a reload without it', () => {
  const storage = memoryStorage()
  expect(readToken('', storage)).toBe('')
  expect(readToken('#token=abc', storage)).toBe('abc')
  expect(readToken('', storage)).toBe('abc')
  expect(readToken('#token=new', storage)).toBe('new')
  expect(readToken('#other=1', storage)).toBe('new')
})
