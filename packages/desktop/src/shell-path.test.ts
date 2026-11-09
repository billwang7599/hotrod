import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fallbackDirs, fixPath, loginShellPath, mergePaths } from './shell-path.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

// A stand-in login shell: prints a banner the way some rc files do, then runs the command it's given.
function fakeShell(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'kothar-shell-'))
  dirs.push(dir)
  const shell = join(dir, 'shell')
  writeFileSync(shell, `#!/bin/sh\n${body}\n`)
  chmodSync(shell, 0o755)
  return shell
}

it('merges PATHs in order, each folder once', () => {
  expect(mergePaths('/a:/b', undefined, '/b:/c::/a')).toBe('/a:/b:/c')
})

it("reads the login shell's PATH past anything its rc files print", async () => {
  const shell = fakeShell(`echo 'Welcome!'\nPATH=/opt/nvm/bin:/usr/bin\nexport PATH\nexec /bin/sh -c "$2"`)
  expect(await loginShellPath(shell)).toBe('/opt/nvm/bin:/usr/bin')
})

it('gives up on a shell that fails', async () => {
  expect(await loginShellPath(fakeShell('exit 3'))).toBeUndefined()
  expect(await loginShellPath('/no/such/shell')).toBeUndefined()
})

it("puts the login shell's PATH ahead of the one a Finder launch gets", async () => {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
  await fixPath(env, async () => '/Users/me/.nvm/versions/node/v26/bin:/opt/homebrew/bin:/usr/bin')
  expect(env.PATH).toBe('/Users/me/.nvm/versions/node/v26/bin:/opt/homebrew/bin:/usr/bin:/bin')
})

it('falls back to the usual install folders when the shell gives nothing', async () => {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
  await fixPath(env, async () => undefined)
  expect(env.PATH).toBe([...fallbackDirs(), '/usr/bin', '/bin'].join(':'))
})
