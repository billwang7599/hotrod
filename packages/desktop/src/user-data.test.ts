import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runningIn, userDataDir } from './user-data.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function appData(withOld: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'kothar-appdata-'))
  dirs.push(dir)
  if (withOld) {
    mkdirSync(join(dir, 'Hotrod Desktop', 'Local Storage'), { recursive: true })
    writeFileSync(join(dir, 'Hotrod Desktop', 'Local Storage', 'prefs'), 'theme')
  }
  return dir
}

it('a fresh install keeps its window data in Kothar Desktop', () => {
  const dir = appData(false)
  expect(userDataDir(dir)).toBe(join(dir, 'Kothar Desktop'))
})

it('window data from when Kothar was Hotrod moves to Kothar Desktop, preferences and all', () => {
  const dir = appData(true)
  expect(userDataDir(dir, { running: () => false })).toBe(join(dir, 'Kothar Desktop'))
  expect(readFileSync(join(dir, 'Kothar Desktop', 'Local Storage', 'prefs'), 'utf8')).toBe('theme')
  expect(existsSync(join(dir, 'Hotrod Desktop'))).toBe(false)
})

it('leaves the old folder alone when Kothar Desktop already exists', () => {
  const dir = appData(true)
  mkdirSync(join(dir, 'Kothar Desktop'))
  expect(userDataDir(dir, { running: () => false })).toBe(join(dir, 'Kothar Desktop'))
  expect(existsSync(join(dir, 'Hotrod Desktop'))).toBe(true)
})

it('keeps using the old folder while the old app runs on it, or when the move fails', () => {
  const dir = appData(true)
  expect(userDataDir(dir, { running: () => true })).toBe(join(dir, 'Hotrod Desktop'))
  const logged: string[] = []
  const rename = () => {
    throw new Error('EXDEV')
  }
  const options = { running: () => false, rename, log: (m: string) => logged.push(m) }
  expect(userDataDir(dir, options)).toBe(join(dir, 'Hotrod Desktop'))
  expect(logged.join()).toContain('EXDEV')
  expect(existsSync(join(dir, 'Kothar Desktop'))).toBe(false)
})

it("tells a running app's folder from one a crashed app left its lock in", () => {
  const dir = appData(true)
  const old = join(dir, 'Hotrod Desktop')
  expect(runningIn(old)).toBe(false)
  symlinkSync(`${hostname()}-${process.pid}`, join(old, 'SingletonLock'))
  expect(runningIn(old)).toBe(true)
  rmSync(join(old, 'SingletonLock'))
  symlinkSync(`${hostname()}-999999`, join(old, 'SingletonLock'))
  expect(runningIn(old)).toBe(false)
})
