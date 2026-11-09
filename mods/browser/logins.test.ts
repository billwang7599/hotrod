import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, expect, it } from 'vitest'
import { chromeDataDir, copyLogins, findProfile } from './logins.ts'

const dirs: string[] = []
const tempDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// A Chrome profile with a cookies database of the given rows and a site's local storage.
function chromeProfile(dataDir: string, name: string, cookies: string[], where = join('Network', 'Cookies')) {
  const profile = join(dataDir, name)
  mkdirSync(join(profile, 'Network'), { recursive: true })
  const db = new DatabaseSync(join(profile, where))
  db.exec('CREATE TABLE IF NOT EXISTS cookies (host_key TEXT, name TEXT)')
  db.exec('DELETE FROM cookies')
  for (const cookie of cookies) db.prepare('INSERT INTO cookies VALUES (?, ?)').run('example.com', cookie)
  db.close()
  mkdirSync(join(profile, 'Local Storage', 'leveldb'), { recursive: true })
  writeFileSync(join(profile, 'Local Storage', 'leveldb', '000003.log'), 'token')
  writeFileSync(join(profile, 'Local Storage', 'leveldb', 'LOCK'), '')
  return profile
}

const cookiesIn = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (db.prepare('SELECT name FROM cookies ORDER BY name').all() as { name: string }[]).map((row) => row.name)
  } finally {
    db.close()
  }
}

it("finds Chrome's folder where Playwright does", () => {
  expect(chromeDataDir('darwin', '/Users/me')).toBe('/Users/me/Library/Application Support/Google/Chrome')
  expect(chromeDataDir('linux', '/home/me')).toBe('/home/me/.config/google-chrome')
})

it("picks Chrome's last used profile with cookies, else Default, else any, by its name in Chrome", () => {
  const dataDir = tempDir('kothar-chrome-')
  expect(findProfile(dataDir)).toBeUndefined()
  chromeProfile(dataDir, 'Profile 3', ['a'])
  writeFileSync(
    join(dataDir, 'Local State'),
    JSON.stringify({ profile: { last_used: 'Profile 2', info_cache: { 'Profile 3': { name: 'Work' } } } }),
  )
  // Profile 2 has no cookies, and there's no Default: the one the info cache knows.
  expect(findProfile(dataDir)).toEqual({ dir: join(dataDir, 'Profile 3'), name: 'Profile 3', label: 'Work' })
  chromeProfile(dataDir, 'Default', ['a'], 'Cookies')
  expect(findProfile(dataDir)?.name).toBe('Default')
  chromeProfile(dataDir, 'Profile 2', ['a'])
  expect(findProfile(dataDir)).toEqual({ dir: join(dataDir, 'Profile 2'), name: 'Profile 2', label: 'Profile 2' })
})

it("copies a profile's cookies and local storage, and copies again only once Chrome's are newer", () => {
  const dataDir = tempDir('kothar-chrome-')
  const copy = tempDir('kothar-logins-')
  const source = chromeProfile(dataDir, 'Default', ['session', 'theme'])
  const profile = findProfile(dataDir)!
  expect(copyLogins(profile, copy)).toBe(true)
  expect(cookiesIn(join(copy, 'Default', 'Network', 'Cookies'))).toEqual(['session', 'theme'])
  expect(readFileSync(join(copy, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'utf8')).toBe('token')
  // The lock is the running Chrome's, not part of the data.
  expect(existsSync(join(copy, 'Default', 'Local Storage', 'leveldb', 'LOCK'))).toBe(false)

  // An agent's own changes to the copy stay while Chrome's logins haven't changed.
  writeFileSync(join(copy, 'Default', 'Network', 'Cookies-journal'), 'stale')
  expect(copyLogins(profile, copy)).toBe(false)
  expect(existsSync(join(copy, 'Default', 'Network', 'Cookies-journal'))).toBe(true)

  chromeProfile(dataDir, 'Default', ['session2'])
  const later = new Date(Date.now() + 60_000)
  utimesSync(join(source, 'Network', 'Cookies'), later, later)
  expect(copyLogins(profile, copy)).toBe(true)
  expect(cookiesIn(join(copy, 'Default', 'Network', 'Cookies'))).toEqual(['session2'])
  // The old copy's journal would be replayed into the new one.
  expect(existsSync(join(copy, 'Default', 'Network', 'Cookies-journal'))).toBe(false)
})

it('copies again when the profile changes, and fails clearly for a profile without cookies', () => {
  const dataDir = tempDir('kothar-chrome-')
  const copy = tempDir('kothar-logins-')
  chromeProfile(dataDir, 'Default', ['home'])
  chromeProfile(dataDir, 'Profile 1', ['work'], 'Cookies')
  expect(copyLogins(findProfile(dataDir)!, copy)).toBe(true)
  writeFileSync(join(dataDir, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 1' } }))
  expect(copyLogins(findProfile(dataDir)!, copy)).toBe(true)
  // Profile 1 keeps its cookies in the profile itself, so the copy does too, and the Network one is gone.
  expect(cookiesIn(join(copy, 'Default', 'Cookies'))).toEqual(['work'])
  expect(existsSync(join(copy, 'Default', 'Network', 'Cookies'))).toBe(false)
  const empty = { dir: join(dataDir, 'Profile 9'), name: 'Profile 9', label: 'Empty' }
  expect(() => copyLogins(empty, copy)).toThrow('Chrome’s profile “Empty” has no cookies'.replace('’', "'"))
})
