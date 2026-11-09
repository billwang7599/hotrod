import { expect, test } from 'vitest'
import { attachmentUrl, coreUrl, readToken } from './connection.ts'

const page = { protocol: 'http:', host: '127.0.0.1:5000' }

test('a built UI connects to the host that served it', () => {
  expect(coreUrl({ DEV: false }, page, 't')).toBe('ws://127.0.0.1:5000/?token=t')
  expect(coreUrl({ DEV: false }, { protocol: 'https:', host: 'example.test' }, 't')).toBe('wss://example.test/?token=t')
})

test('the dev server connects to the default core port', () => {
  expect(coreUrl({ DEV: true }, { protocol: 'http:', host: 'localhost:4318' }, 't')).toBe('ws://127.0.0.1:4317/?token=t')
})

test('VITE_KOTHAR_CORE_URL wins in dev and in a build', () => {
  const env = { VITE_KOTHAR_CORE_URL: 'ws://127.0.0.1:4461' }
  expect(coreUrl({ ...env, DEV: true }, page, 't')).toBe('ws://127.0.0.1:4461/?token=t')
  expect(coreUrl({ ...env, DEV: false }, page, 't')).toBe('ws://127.0.0.1:4461/?token=t')
})

test('VITE_HOTROD_CORE_URL, its name from before the rename, still works', () => {
  const old = { DEV: true, VITE_HOTROD_CORE_URL: 'ws://127.0.0.1:4462' }
  expect(coreUrl(old, page, 't')).toBe('ws://127.0.0.1:4462/?token=t')
  expect(coreUrl({ ...old, VITE_KOTHAR_CORE_URL: 'ws://127.0.0.1:4461' }, page, 't')).toBe('ws://127.0.0.1:4461/?token=t')
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

test("an attachment's URL is the core's HTTP address with the token, one escaped file name per chat", () => {
  const path = '/garage/chats/main/attachments/my shot#1.png'
  expect(attachmentUrl('ws://127.0.0.1:4317/?token=a%2Bb', 'main', path)).toBe(
    'http://127.0.0.1:4317/chats/main/attachments/my%20shot%231.png?token=a%2Bb',
  )
  expect(attachmentUrl('wss://example.test/?token=t', 'ab12', '/x/a.pdf')).toBe(
    'https://example.test/chats/ab12/attachments/a.pdf?token=t',
  )
})
