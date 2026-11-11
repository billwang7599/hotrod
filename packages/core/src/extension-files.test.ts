import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { extensionPicture, MAX_PICTURE_BYTES } from './extension-files.ts'

let garage: string
let roots: Parameters<typeof extensionPicture>[1]
beforeEach(() => {
  garage = mkdtempSync(join(tmpdir(), 'kothar-files-'))
  const storage = join(garage, 'extensions', 'notes')
  const chat = join(garage, 'chats', 'c1')
  mkdirSync(join(storage, 'attachments'), { recursive: true })
  mkdirSync(join(chat, 'notes', 'attachments'), { recursive: true })
  mkdirSync(join(chat, 'attachments'), { recursive: true })
  roots = { storage, chatDirs: [chat], chatOwnFiles: ['chat.json', 'log.jsonl', 'attachments'] }
})
afterEach(() => rmSync(garage, { recursive: true, force: true }))

const put = (path: string, bytes: string | Buffer = 'png') => {
  writeFileSync(join(garage, path), bytes)
  return join(garage, path)
}

test("serves pictures in the extension's storage and in chat folders outside the core's own files", () => {
  expect(extensionPicture(put('extensions/notes/attachments/a.png'), roots)).toEqual({ path: expect.stringMatching(/a\.png$/), mimeType: 'image/png' })
  expect(extensionPicture(put('chats/c1/notes/attachments/b.JPG'), roots)).toMatchObject({ mimeType: 'image/jpeg' })
  expect(extensionPicture(put('chats/c1/notes/c.webp'), roots)).toMatchObject({ mimeType: 'image/webp' })
})

test("refuses the core's own chat files, other extensions, other folders, non-pictures and SVG", () => {
  const refused = (path: string) => 'error' in extensionPicture(path, roots)
  expect(refused(put('chats/c1/attachments/upload.png'))).toBe(true)
  mkdirSync(join(garage, 'extensions', 'other'), { recursive: true })
  expect(refused(put('extensions/other/x.png'))).toBe(true)
  expect(refused(put('outside.png'))).toBe(true)
  expect(refused(put('extensions/notes/note.md'))).toBe(true)
  expect(refused(put('extensions/notes/pic.svg', '<svg onload="x()"/>'))).toBe(true)
  expect(refused(put('chats/c1/log.jsonl'))).toBe(true)
  // A relative path, a missing file, a NUL byte, a folder named like a picture.
  expect(refused('extensions/notes/attachments/a.png')).toBe(true)
  expect(refused(join(garage, 'extensions/notes/missing.png'))).toBe(true)
  expect(refused(join(garage, 'extensions/notes/a\0.png'))).toBe(true)
  mkdirSync(join(garage, 'extensions/notes/dir.png'))
  expect(refused(join(garage, 'extensions/notes/dir.png'))).toBe(true)
})

test('.. and symlinks are resolved before the check, so neither leads out', () => {
  const outside = put('secret.png')
  expect('error' in extensionPicture(join(garage, 'extensions/notes/attachments/../../../secret.png'), roots)).toBe(true)
  symlinkSync(outside, join(garage, 'extensions/notes/attachments/link.png'))
  expect('error' in extensionPicture(join(garage, 'extensions/notes/attachments/link.png'), roots)).toBe(true)
  // A link named .png to a file of another kind inside the folder isn't served either.
  const text = put('extensions/notes/plain.txt', 'secret text')
  symlinkSync(text, join(garage, 'extensions/notes/fake.png'))
  expect(extensionPicture(join(garage, 'extensions/notes/fake.png'), roots)).toEqual({ error: 'not a picture' })
  // A link into a reserved folder of a chat.
  const upload = put('chats/c1/attachments/up.png')
  symlinkSync(upload, join(garage, 'chats/c1/notes/up.png'))
  expect('error' in extensionPicture(join(garage, 'chats/c1/notes/up.png'), roots)).toBe(true)
})

test('refuses a picture over the size limit', () => {
  const big = put('extensions/notes/big.png', Buffer.alloc(MAX_PICTURE_BYTES + 1))
  expect(extensionPicture(big, roots)).toEqual({ error: 'too big' })
})
