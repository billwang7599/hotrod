import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeCode } from './adapters/claude-code.ts'
import { createFakeAdapter } from './adapters/fake.ts'
import { pi } from './adapters/pi.ts'
import { openCore } from './core.ts'
import { localMachine } from './machine.ts'
import { startServer } from './server.ts'
import type { Adapter } from './types.ts'

const adapters: Record<string, Adapter> = {
  'claude-code': claudeCode,
  pi,
  fake: createFakeAdapter(),
}

export async function startCore(options: { env?: Record<string, string | undefined>; uiDir?: string } = {}) {
  const { env = process.env, uiDir } = options
  const engineId = env.HOTROD_ENGINE ?? 'claude-code'
  const adapter = adapters[engineId]
  if (!adapter) {
    throw new Error(`Unknown engine "${engineId}". Set HOTROD_ENGINE to one of: ${Object.keys(adapters).join(', ')}`)
  }
  const garage = env.HOTROD_GARAGE ?? join(homedir(), 'Library', 'Application Support', 'Hotrod')
  const port = Number(env.HOTROD_PORT ?? 4317)
  const uiUrl = uiDir ? `http://127.0.0.1:${port}` : (env.HOTROD_UI_ORIGIN ?? 'http://localhost:4318')
  const machine = localMachine

  const engine = { id: adapter.id, ...(await adapter.detect(machine)) }
  const core = openCore({ garage, adapter, machine })
  const server = await startServer({ core, engine, port, uiOrigin: uiUrl, uiDir })
  return {
    core,
    engine,
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
    console.log(`Hotrod core on ws://127.0.0.1:${hotrod.port} (engine ${hotrod.engine.id}, garage ${hotrod.garage})`)
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
