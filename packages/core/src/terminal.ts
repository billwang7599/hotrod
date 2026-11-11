import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Opens the user's terminal app at a folder, for the Open in Terminal buttons. It runs on this computer, where the user
// is, not through the Machine: the terminal is the user's window, not a command an agent runs.

// One way to start a program. wait: it hands the work to another app and exits (macOS `open`), so its exit code says
// whether that worked; otherwise it's the terminal itself, and starting is enough.
export type Launch = { command: string; args: string[]; cwd?: string; wait: boolean }

// Starts a launch, detached. Rejects with code ENOENT when the program isn't there, else with what went wrong.
export type Spawner = (launch: Launch) => Promise<void>

// macOS terminals Kothar knows by name. A terminal that takes a folder as a file to open goes with `open -b <id> <dir>`;
// one that doesn't is started with its own flag for the working directory.
type MacTerminal = { id: string; name: string; bundle: string; args?: (dir: string) => string[] }

export const MAC_TERMINALS: MacTerminal[] = [
  { id: 'terminal', name: 'Terminal', bundle: 'com.apple.Terminal' },
  { id: 'iterm', name: 'iTerm2', bundle: 'com.googlecode.iterm2' },
  { id: 'ghostty', name: 'Ghostty', bundle: 'com.mitchellh.ghostty' },
  { id: 'warp', name: 'Warp', bundle: 'dev.warp.Warp-Stable' },
  { id: 'kitty', name: 'kitty', bundle: 'net.kovidgoyal.kitty', args: (dir) => ['--directory', dir] },
  { id: 'wezterm', name: 'WezTerm', bundle: 'com.github.wez.wezterm', args: (dir) => ['start', '--cwd', dir] },
  { id: 'alacritty', name: 'Alacritty', bundle: 'org.alacritty', args: (dir) => ['--working-directory', dir] },
]

// The setting: automatic, or one of MAC_TERMINALS by id.
export const AUTOMATIC = 'auto'

// Where macOS keeps the user's default apps, under their home folder.
export const launchServicesPlist = (home: string) =>
  join(home, 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist')
// What iTerm2's "Make iTerm2 Default Term" and others claim: the app that opens shell scripts.
const SHELL_TYPES = ['com.apple.terminal.shell-script', 'public.unix-executable']

type Handler = { LSHandlerContentType?: unknown; LSHandlerRoleAll?: unknown; LSHandlerRoleShell?: unknown }

// The bundle id LaunchServices opens shell scripts with, from its plist as JSON, if the user picked one.
export function defaultTerminalOf(plist: unknown): string | undefined {
  const handlers = (plist as { LSHandlers?: unknown })?.LSHandlers
  if (!Array.isArray(handlers)) return undefined
  for (const type of SHELL_TYPES) {
    const handler = (handlers as Handler[]).find((h) => h?.LSHandlerContentType === type)
    const bundle = handler?.LSHandlerRoleShell ?? handler?.LSHandlerRoleAll
    if (typeof bundle === 'string' && bundle && bundle !== '-') return bundle
  }
  return undefined
}

function macLaunch(bundle: string, dir: string): Launch {
  const known = MAC_TERMINALS.find((t) => t.bundle.toLowerCase() === bundle.toLowerCase())
  if (known?.args) return { command: 'open', args: ['-n', '-b', known.bundle, '--args', ...known.args(dir)], wait: true }
  return { command: 'open', args: ['-b', known?.bundle ?? bundle, dir], wait: true }
}

// What to try, in order, to open a terminal at dir. bundle: the terminal LaunchServices names on macOS, if any.
export function launchesFor(
  dir: string,
  { platform, choice = AUTOMATIC, bundle, env = {} }: {
    platform: NodeJS.Platform
    choice?: string
    bundle?: string
    env?: Record<string, string | undefined>
  },
): Launch[] {
  if (platform === 'darwin') {
    const picked = MAC_TERMINALS.find((t) => t.id === choice)
    if (picked) return [macLaunch(picked.bundle, dir)]
    const terminal = macLaunch('com.apple.Terminal', dir)
    return bundle && bundle.toLowerCase() !== 'com.apple.terminal' ? [macLaunch(bundle, dir), terminal] : [terminal]
  }
  if (platform === 'win32') {
    return [
      { command: 'wt.exe', args: ['-d', dir], wait: false },
      { command: 'cmd.exe', args: ['/c', 'start', '', 'cmd.exe'], cwd: dir, wait: false },
    ]
  }
  // Linux and the rest: Debian's alternative, the user's $TERMINAL, then the common desktops' own.
  const own = env.TERMINAL?.trim()
  return [
    { command: 'x-terminal-emulator', args: [], cwd: dir, wait: false },
    ...(own ? [{ command: own, args: [], cwd: dir, wait: false }] : []),
    { command: 'gnome-terminal', args: [`--working-directory=${dir}`], cwd: dir, wait: false },
    { command: 'konsole', args: ['--workdir', dir], cwd: dir, wait: false },
  ]
}

export const nameOf = (choice: string | undefined) => MAC_TERMINALS.find((t) => t.id === choice)?.name

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

// Opens a terminal at dir. Throws a short message for the user when the folder or the terminal isn't there.
export async function openTerminal(
  dir: string,
  options: {
    spawner?: Spawner
    platform?: NodeJS.Platform
    env?: Record<string, string | undefined>
    choice?: string
    // The user's home folder (the core's home), where the macOS LaunchServices plist is read.
    home?: string
    // The macOS LaunchServices plist as JSON, or undefined if it can't be read. Defaults to reading it under home.
    launchServices?: () => Promise<unknown>
  } = {},
) {
  const { spawner = spawnDetached, platform = process.platform, env = process.env, choice } = options
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`The folder is gone: ${dir}`)
  const automatic = !MAC_TERMINALS.some((t) => t.id === choice)
  const bundle =
    platform === 'darwin' && automatic
      ? defaultTerminalOf(await launchServicesOf(options)().catch(() => undefined))
      : undefined
  const launches = launchesFor(dir, { platform, choice, bundle, env })
  let last: unknown
  for (const launch of launches) {
    try {
      return await spawner(launch)
    } catch (error) {
      last = error
      // A terminal the user picked is the one they want; a guess falls back to the next.
      if (!missing(error) && !(platform === 'darwin' && automatic)) break
    }
  }
  const picked = nameOf(choice)
  if (picked && platform === 'darwin') throw new Error(`Couldn't open ${picked}. Is it installed?`)
  if (missing(last)) throw new Error('No terminal app found')
  throw new Error(`Couldn't open a terminal: ${last instanceof Error ? last.message : String(last)}`)
}

// Without a home folder there's no plist to read, and the automatic choice falls back to Terminal.
const launchServicesOf = ({ launchServices, home }: { launchServices?: () => Promise<unknown>; home?: string }) =>
  launchServices ?? (home === undefined ? async () => undefined : () => readLaunchServices(launchServicesPlist(home)))

export async function readLaunchServices(file: string): Promise<unknown> {
  if (!existsSync(file)) return undefined
  const { stdout } = await run({ command: 'plutil', args: ['-convert', 'json', '-o', '-', file], wait: true })
  return JSON.parse(stdout)
}

export const spawnDetached: Spawner = async (launch) => {
  await run(launch)
}

function run(launch: Launch): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      ...(launch.cwd && { cwd: launch.cwd }),
      detached: !launch.wait,
      stdio: launch.wait ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    if (!launch.wait) {
      child.once('spawn', () => {
        child.unref()
        resolve({ stdout })
      })
      return
    }
    child.once('close', (code) =>
      code === 0 ? resolve({ stdout }) : reject(new Error(stderr.trim() || `${launch.command} exited with ${code}`)),
    )
  })
}
