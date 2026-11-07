import { homedir } from 'node:os'
import { join } from 'node:path'
import { createFakeAdapter } from './adapters/fake.ts'
import { openCore } from './core.ts'
import { localMachine } from './machine.ts'
import { startServer } from './server.ts'
import type { Adapter } from './types.ts'

const adapters: Record<string, Adapter> = {
  fake: createFakeAdapter(),
}

const engineId = process.env.HOTROD_ENGINE ?? 'claude-code'
const adapter = adapters[engineId]
if (!adapter) {
  console.error(`Unknown engine "${engineId}". Set HOTROD_ENGINE to one of: ${Object.keys(adapters).join(', ')}`)
  process.exit(1)
}

const garage = process.env.HOTROD_GARAGE ?? join(homedir(), 'Library', 'Application Support', 'Hotrod')
const port = Number(process.env.HOTROD_PORT ?? 4317)
const uiOrigin = process.env.HOTROD_UI_ORIGIN ?? 'http://localhost:4318'
const machine = localMachine

const engine = { id: adapter.id, ...(await adapter.detect(machine)) }
const core = openCore({ garage, adapter, machine })
const server = await startServer({ core, engine, port, uiOrigin })
console.log(`Hotrod core on ws://127.0.0.1:${server.port} (engine ${engine.id}, garage ${garage})`)

const shutdown = async () => {
  core.close()
  await server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
