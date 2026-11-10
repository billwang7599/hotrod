import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Extension } from '@kothar/extension-api'
import { claudeCode } from './adapters/claude-code.ts'
import { codex } from './adapters/codex.ts'
import { createFakeAdapter } from './adapters/fake.ts'
import { opencode } from './adapters/opencode.ts'
import { pi } from './adapters/pi.ts'
import { openCore } from './core.ts'
import { loadCommunityExtensions, loadExtensions } from './extensions.ts'
import { moveGarage, portInUse } from './garage-move.ts'
import { localMachine } from './machine.ts'
import { startServer } from './server.ts'
import type { Adapter, Machine } from './shared.ts'
import { renameSettings } from './vocab-move.ts'

const registered: Adapter[] = [claudeCode, pi, codex, opencode, createFakeAdapter(undefined, undefined, { steering: true })]
const STOCK_EXTENSIONS_DIR = fileURLToPath(new URL('../../../extensions/', import.meta.url))

// Kothar was called Hotrod; installs from then keep working, so every KOTHAR_ variable falls back to its HOTROD_ name.
export function envVar(env: Record<string, string | undefined>, name: string): string | undefined {
  return env[`KOTHAR_${name}`] ?? env[`HOTROD_${name}`]
}

// Kothar's garage. One from when Kothar was Hotrod moves here on the first launch after the rename (see
// garage-move.ts); it stays in use where it is only if the move can't happen yet.
export function defaultGarage(
  options: { home?: string; machine?: Machine; inUse?: () => Promise<boolean>; log?: (message: string) => void } = {},
) {
  const { home = homedir(), machine = localMachine, inUse = async () => false, log } = options
  const support = join(home, 'Library', 'Application Support')
  return moveGarage({ from: join(support, 'Hotrod'), to: join(support, 'Kothar'), machine, inUse, log })
}

export async function startCore(
  options: {
    env?: Record<string, string | undefined>
    uiDir?: string
    adapters?: Adapter[]
    extensions?: Extension[]
    machine?: Machine
    home?: string
    // Where the built-in extensions are: the repo's extensions/ unless a packaged app ships them elsewhere.
    extensionsDir?: string
    // How this host restarts Kothar; see openCore's restart.
    restart?: () => void
    // Tests pass a stub, so no terminal really opens.
    openTerminal?: (dir: string, choice?: string) => Promise<void>
  } = {},
) {
  const { env = process.env, home, uiDir, adapters = registered, machine = localMachine } = options
  const extensionsDir = options.extensionsDir ?? STOCK_EXTENSIONS_DIR
  const { extensions, brokenExtensions } = options.extensions ? { extensions: options.extensions, brokenExtensions: [] } : await loadExtensions(extensionsDir)
  const port = Number(envVar(env, 'PORT') ?? 4317)
  const garage = envVar(env, 'GARAGE') ?? (await defaultGarage({ home, machine, inUse: () => portInUse(port) }))
  const uiUrl = uiDir ? `http://127.0.0.1:${port}` : (envVar(env, 'UI_ORIGIN') ?? 'http://localhost:4318')
  const token = envVar(env, 'TOKEN') || randomBytes(32).toString('base64url')

  const engine = envVar(env, 'ENGINE')
  const defaultEngine = engine ?? adapters[0]?.id ?? ''
  const marketplaceUrl = envVar(env, 'MARKETPLACE_URL')
  const githubToken = envVar(env, 'GITHUB_TOKEN')
  const community = options.extensions ? [] : await loadCommunityExtensions(garage, (id) => savedOn(garage, id))
  const core = openCore({
    garage,
    adapters,
    defaultEngine,
    machine,
    extensions,
    brokenExtensions,
    community,
    marketplaceUrl,
    githubToken,
    ...(options.restart && { restart: options.restart }),
    ...(options.openTerminal && { openTerminal: options.openTerminal }),
  })
  if (engine) core.setEngineEnabled(engine, true)
  const work = envVar(env, 'WORK')
  if (work) core.setWorkFolder(work)
  await core.refreshEngines()
  const server = await startServer({ core, port, uiOrigin: uiUrl, token, uiDir })
  return {
    core,
    garage,
    port: server.port,
    uiUrl,
    token,
    openUrl: `${uiUrl}/#token=${encodeURIComponent(token)}`,
    close: async (force = false) => {
      await Promise.all([core.close(force), server.close()])
    },
  }
}

// Whether settings.json has community extensions on and this one turned on, read before the core opens so only
// extensions that are on get imported. Settings saved when extensions were mods are read under the new names.
export function savedOn(garage: string, id: string) {
  try {
    const settings = JSON.parse(readFileSync(join(garage, 'settings.json'), 'utf8'))
    renameSettings(settings)
    return settings.communityExtensions === true && settings.extensions?.[id]?.enabled === true
  } catch {
    return false
  }
}

// Runs the core and restarts it in this process when asked (npm run dev): the old one stops every chat as quitting does,
// and the new one reads the settings and community extensions again on the same port and token, so the UI reconnects.
export async function runRestartable(start: (restart: () => void) => ReturnType<typeof startCore>) {
  let restarting: Promise<void> | undefined
  const restart = () => {
    restarting ??= (async () => {
      await kothar.close()
      kothar = await start(restart)
      console.log('Kothar restarted.')
    })().finally(() => (restarting = undefined))
  }
  let kothar = await start(restart)
  return { current: () => kothar, close: async (force = false) => kothar.close(force) }
}

export function closeOnSignals(close: (force?: boolean) => Promise<void>) {
  let signals = 0
  const shutdown = async () => {
    signals++
    if (signals === 1) {
      console.log('Stopping engines… press Ctrl+C again to force quit.')
      await close()
      process.exit(signals > 1 ? 1 : 0)
    }
    if (signals > 2) process.exit(1)
    console.log('Force quitting… press Ctrl+C again to quit now.')
    await close(true)
    process.exit(1)
  }
  // Engines sit in their own process groups, so a closed terminal's SIGHUP reaches only the core.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, shutdown)
}

if (import.meta.main) {
  try {
    const env = { ...process.env }
    // The UI must find the core again after a restart, so the token stays the same.
    env.KOTHAR_TOKEN ||= randomBytes(32).toString('base64url')
    const run = await runRestartable((restart) => startCore({ env, restart }))
    const kothar = run.current()
    console.log(`Kothar core on ws://127.0.0.1:${kothar.port} (garage ${kothar.garage})`)
    console.log(`Open ${kothar.openUrl}`)
    closeOnSignals(run.close)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
