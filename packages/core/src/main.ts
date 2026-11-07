import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeCode } from './adapters/claude-code.ts'
import { createFakeAdapter } from './adapters/fake.ts'
import { pi } from './adapters/pi.ts'
import { openCore } from './core.ts'
import { localMachine } from './machine.ts'
import { startServer } from './server.ts'
import type { Adapter, EngineInfo } from './types.ts'

const registered: Adapter[] = [claudeCode, pi, createFakeAdapter()]

export async function startCore(
  options: { env?: Record<string, string | undefined>; uiDir?: string; adapters?: Adapter[] } = {},
) {
  const { env = process.env, uiDir, adapters = registered } = options
  const garage = env.HOTROD_GARAGE ?? join(homedir(), 'Library', 'Application Support', 'Hotrod')
  const port = Number(env.HOTROD_PORT ?? 4317)
  const uiUrl = uiDir ? `http://127.0.0.1:${port}` : (env.HOTROD_UI_ORIGIN ?? 'http://localhost:4318')
  const machine = localMachine

  const core = openCore({ garage, adapters, defaultEngine: env.HOTROD_ENGINE ?? 'claude-code', machine })
  const engines = await Promise.all(
    adapters.map(async (adapter): Promise<EngineInfo> => {
      try {
        return { id: adapter.id, ...(await adapter.detect(machine)) }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return { id: adapter.id, installed: false, signedIn: false, detail }
      }
    }),
  )
  const server = await startServer({ core, engines, port, uiOrigin: uiUrl, uiDir })
  return {
    core,
    engines,
    garage,
    port: server.port,
    uiUrl,
    close: async () => {
      core.close()
      await server.close()
    },
  }
}

if (import.meta.main) {
  try {
    const hotrod = await startCore()
    console.log(`Hotrod core on ws://127.0.0.1:${hotrod.port} (garage ${hotrod.garage})`)
    const shutdown = async () => {
      await hotrod.close()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
