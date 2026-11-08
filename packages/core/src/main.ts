import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Mod } from '@hotrod/mod-api'
import { claudeCode } from './adapters/claude-code.ts'
import { createFakeAdapter } from './adapters/fake.ts'
import { pi } from './adapters/pi.ts'
import { openCore } from './core.ts'
import { localMachine } from './machine.ts'
import { loadMods } from './mods.ts'
import { startServer } from './server.ts'
import type { Adapter, Machine } from './shared.ts'

const registered: Adapter[] = [claudeCode, pi, createFakeAdapter()]
const STOCK_MODS_DIR = fileURLToPath(new URL('../../../mods/', import.meta.url))

export async function startCore(
  options: {
    env?: Record<string, string | undefined>
    uiDir?: string
    adapters?: Adapter[]
    mods?: Mod[]
    machine?: Machine
  } = {},
) {
  const { env = process.env, uiDir, adapters = registered, machine = localMachine } = options
  const { mods, brokenMods } = options.mods ? { mods: options.mods, brokenMods: [] } : await loadMods(STOCK_MODS_DIR)
  const garage = env.HOTROD_GARAGE ?? join(homedir(), 'Library', 'Application Support', 'Hotrod')
  const port = Number(env.HOTROD_PORT ?? 4317)
  const uiUrl = uiDir ? `http://127.0.0.1:${port}` : (env.HOTROD_UI_ORIGIN ?? 'http://localhost:4318')
  const token = env.HOTROD_TOKEN || randomBytes(32).toString('base64url')

  const defaultEngine = env.HOTROD_ENGINE ?? adapters[0]?.id ?? ''
  const core = openCore({ garage, adapters, defaultEngine, machine, mods, brokenMods })
  if (env.HOTROD_ENGINE) core.setEngineEnabled(env.HOTROD_ENGINE, true)
  if (env.HOTROD_WORK) core.setWorkFolder(env.HOTROD_WORK)
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
    const hotrod = await startCore()
    console.log(`Hotrod core on ws://127.0.0.1:${hotrod.port} (garage ${hotrod.garage})`)
    console.log(`Open ${hotrod.openUrl}`)
    closeOnSignals(hotrod.close)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
