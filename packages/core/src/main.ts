import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Mod } from '@kothar/mod-api'
import { claudeCode } from './adapters/claude-code.ts'
import { createFakeAdapter } from './adapters/fake.ts'
import { pi } from './adapters/pi.ts'
import { openCore } from './core.ts'
import { moveGarage, portInUse } from './garage-move.ts'
import { localMachine } from './machine.ts'
import { loadCommunityMods, loadMods } from './mods.ts'
import { startServer } from './server.ts'
import type { Adapter, Machine } from './shared.ts'

const registered: Adapter[] = [claudeCode, pi, createFakeAdapter(undefined, undefined, { steering: true })]
const STOCK_MODS_DIR = fileURLToPath(new URL('../../../mods/', import.meta.url))

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
    mods?: Mod[]
    machine?: Machine
    home?: string
  } = {},
) {
  const { env = process.env, home, uiDir, adapters = registered, machine = localMachine } = options
  const { mods, brokenMods } = options.mods ? { mods: options.mods, brokenMods: [] } : await loadMods(STOCK_MODS_DIR)
  const port = Number(envVar(env, 'PORT') ?? 4317)
  const garage = envVar(env, 'GARAGE') ?? (await defaultGarage({ home, machine, inUse: () => portInUse(port) }))
  const uiUrl = uiDir ? `http://127.0.0.1:${port}` : (envVar(env, 'UI_ORIGIN') ?? 'http://localhost:4318')
  const token = envVar(env, 'TOKEN') || randomBytes(32).toString('base64url')

  const engine = envVar(env, 'ENGINE')
  const defaultEngine = engine ?? adapters[0]?.id ?? ''
  const marketplaceUrl = envVar(env, 'MARKETPLACE_URL')
  const githubToken = envVar(env, 'GITHUB_TOKEN')
  const community = options.mods ? [] : await loadCommunityMods(garage, (id) => savedOn(garage, id))
  const core = openCore({
    garage,
    adapters,
    defaultEngine,
    machine,
    mods,
    brokenMods,
    community,
    marketplaceUrl,
    githubToken,
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

// Whether settings.json has the mod turned on, read before the core opens so only mods that are on get imported.
function savedOn(garage: string, id: string) {
  try {
    return JSON.parse(readFileSync(join(garage, 'settings.json'), 'utf8')).mods?.[id]?.enabled === true
  } catch {
    return false
  }
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
    const kothar = await startCore()
    console.log(`Kothar core on ws://127.0.0.1:${kothar.port} (garage ${kothar.garage})`)
    console.log(`Open ${kothar.openUrl}`)
    closeOnSignals(kothar.close)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
