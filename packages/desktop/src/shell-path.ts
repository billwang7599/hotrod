import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const MARK = '__KOTHAR_PATH__'
export const SHELL_TIMEOUT_MS = 5000

// Where engines usually live when the login shell can't be asked: Homebrew, npm's and pipx's user folders.
export const fallbackDirs = (home = homedir()) => [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(home, '.local', 'bin'),
  join(home, '.npm-global', 'bin'),
  join(home, '.bun', 'bin'),
]

// Joins the PATHs in order, keeping each folder once and dropping empty entries.
export function mergePaths(...paths: (string | undefined)[]) {
  const seen = new Set<string>()
  for (const path of paths) for (const dir of path?.split(delimiter) ?? []) if (dir) seen.add(dir)
  return [...seen].join(delimiter)
}

// The PATH an interactive login shell sets up, which is where nvm, Homebrew and npm put engines. Rc files may print
// banners, so the value sits between markers. Undefined when the shell fails or takes too long.
export function loginShellPath(
  shell = process.env.SHELL || '/bin/zsh',
  run: typeof execFile = execFile,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    run(
      shell,
      ['-ilc', `printf '%s' "${MARK}\${PATH}${MARK}"`],
      { timeout: SHELL_TIMEOUT_MS, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' } },
      (error, stdout) => {
        const found = !error && String(stdout).split(MARK)
        resolve(found && found.length >= 3 ? found[1] : undefined)
      },
    )
  })
}

// An app opened from Finder gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), which misses every engine. This puts
// the login shell's PATH first, then common install folders, then whatever the app started with.
export async function fixPath(env: NodeJS.ProcessEnv = process.env, ask = () => loginShellPath(env.SHELL)) {
  const shellPath = await ask()
  env.PATH = mergePaths(shellPath, shellPath ? undefined : fallbackDirs().join(delimiter), env.PATH)
  return env.PATH
}
