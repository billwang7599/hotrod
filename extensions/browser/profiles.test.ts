import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { chromiumMajor, findBrowser, windowUserAgent } from './profiles.ts'

const dirs: string[] = []
const tempDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const write = (path: string, text = 'x') => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

it("tells a browser's Chromium version from its app, for a user agent that doesn't say headless", () => {
  const home = tempDir('kothar-home-')
  const apps = join(home, 'Applications')
  write(join(apps, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'))
  mkdirSync(join(apps, 'Google Chrome.app', 'Contents', 'Frameworks', 'Google Chrome Framework.framework', 'Versions', '157.0.8103.39'), { recursive: true })
  write(join(apps, 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'))
  const chrome = findBrowser({ home, apps: [join(home, 'Nowhere'), apps] }, 'darwin')!
  expect(chrome.id).toBe('chrome')
  expect(chromiumMajor(chrome.executable)).toBe(157)
  expect(chromiumMajor(join(apps, 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'))).toBeUndefined()
  expect(windowUserAgent(157)).toContain('Chrome/157.0.0.0 Safari')
  expect(windowUserAgent(157)).not.toContain('Headless')
})
