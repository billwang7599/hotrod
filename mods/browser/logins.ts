// "Your Chrome's logins, in the background": Playwright MCP on the user's Google Chrome, headless, on a profile of
// Kothar's own that holds a copy of one Chrome profile's logins (its cookies and its sites' local storage). Never
// the user's running Chrome, so nothing opens, shows or takes focus.
//
// The session's MCP server runs this file: `node logins.ts run <copy> <cli.js> ...args` copies the logins into
// <copy> when Chrome's are newer, then becomes Playwright MCP. `node logins.ts check` prints the profile it would copy.
// It runs as the session's own process, inside its sandbox, which lets it read Chrome's profile and write only the
// copy in the work folder.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

// Chrome's own folder, as Playwright's defaultUserDataDirForChannel('chrome') finds it.
export const chromeDataDir = (platform = process.platform, home = homedir()) =>
  platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Google', 'Chrome')
    : join(home, '.config', 'google-chrome')

// Where a profile keeps its cookies: Network/ since Chrome 96, the profile itself before (and again in some builds).
const COOKIES = [join('Network', 'Cookies'), 'Cookies']
// The rest of a login: sites that keep their session token in localStorage. Not IndexedDB, which can be gigabytes.
const LOCAL_STORAGE = join('Local Storage', 'leveldb')
// Records which profile the copy came from and how new it was, so a copy is only redone when Chrome's is newer.
const MARKER = 'kothar-logins.json'

const read = (file: string) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

const cookiesOf = (profileDir: string) => COOKIES.find((file) => existsSync(join(profileDir, file)))

export type LoginsProfile = { dir: string; name: string; label: string }

// The profile whose logins are copied: Chrome's last used one that has cookies, else the first that has any.
export function findProfile(dataDir = chromeDataDir()): LoginsProfile | undefined {
  const state = read(join(dataDir, 'Local State'))?.profile
  const cache: Record<string, { name?: string }> = state?.info_cache ?? {}
  const names = [state?.last_used, 'Default', ...Object.keys(cache)].filter(
    (name, i, all): name is string => typeof name === 'string' && all.indexOf(name) === i,
  )
  const name = names.find((candidate) => cookiesOf(join(dataDir, candidate)))
  if (!name) return undefined
  return { dir: join(dataDir, name), name, label: cache[name]?.name ?? name }
}

// Copies the profile's logins into copyDir/Default unless the copy is already as new. Cookies go through SQLite's
// VACUUM INTO, a consistent snapshot even while Chrome writes to them; a plain file copy can catch a write halfway.
// Returns whether it copied.
export function copyLogins(profile: LoginsProfile, copyDir: string): boolean {
  const cookies = cookiesOf(profile.dir)
  if (!cookies) throw new Error(`Chrome's profile “${profile.label}” has no cookies`)
  const source = join(profile.dir, cookies)
  const newest = statSync(source).mtimeMs
  const marker = join(copyDir, MARKER)
  const copied = read(marker)
  const target = join(copyDir, 'Default')
  if (copied?.profile === profile.dir && copied.mtimeMs >= newest && existsSync(join(target, cookies))) return false

  mkdirSync(join(target, 'Network'), { recursive: true })
  const into = join(target, cookies)
  const partial = `${into}.kothar-partial`
  rmSync(partial, { force: true })
  // Chrome writes its cookies in short transactions; the timeout waits one out instead of failing.
  const db = new DatabaseSync(source, { readOnly: true, timeout: 5_000 })
  try {
    db.exec(`VACUUM INTO '${partial.replaceAll("'", "''")}'`)
  } finally {
    db.close()
  }
  // A copy from the other place, or the journal of the copy it replaces, would be read as part of this one.
  for (const file of COOKIES) for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(join(target, file + suffix), { force: true })
  renameSync(partial, into)

  const storage = join(profile.dir, LOCAL_STORAGE)
  rmSync(join(target, LOCAL_STORAGE), { recursive: true, force: true })
  if (existsSync(storage)) {
    cpSync(storage, join(target, LOCAL_STORAGE), { recursive: true, filter: (file) => !file.endsWith('LOCK') })
  }
  writeFileSync(marker, JSON.stringify({ profile: profile.dir, mtimeMs: newest }))
  return true
}

async function main([command, ...args]: string[]) {
  if (command === 'check') {
    console.log(JSON.stringify({ profile: findProfile() ?? null }))
    return
  }
  if (command !== 'run') throw new Error(`Unknown command ${command}`)
  const [copyDir, cli, ...cliArgs] = args
  if (!copyDir || !cli) throw new Error('Usage: logins.ts run <copy folder> <Playwright MCP cli.js> ...args')
  // A subagent's copy is its own, so it can run beside its space's browser, and goes when its session does.
  if (process.env.KOTHAR_LOGINS_TEMPORARY) {
    process.on('exit', () => {
      try {
        rmSync(copyDir, { recursive: true, force: true })
      } catch {}
    })
  }
  // A copy that fails leaves the agent browsing without logins rather than without a browser; stderr says why.
  try {
    const profile = findProfile()
    if (!profile) throw new Error('no Chrome profile with cookies found')
    copyLogins(profile, copyDir)
  } catch (error) {
    console.error(`Kothar couldn't copy your Chrome logins: ${(error as Error).message}`)
  }
  process.argv = [process.argv[0]!, cli, ...cliArgs]
  await import(pathToFileURL(cli).href)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
