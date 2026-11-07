import type { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import type { Core } from './core.ts'
import type { CoreMessage, EngineStatus } from './types.ts'

export async function startServer(options: {
  core: Core
  engine: { id: string } & EngineStatus
  port: number
  uiOrigin: string
}) {
  const { core, engine, port, uiOrigin } = options
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient: (info, accept) => accept(info.origin === uiOrigin, 403, 'Origin not allowed'),
  })
  const send = (socket: WebSocket, message: CoreMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  core.onMessage((message) => wss.clients.forEach((socket) => send(socket, message)))

  wss.on('connection', (socket) => {
    send(socket, { type: 'snapshot', engine, projects: core.projects() })
    socket.on('message', (data) => {
      try {
        core.handle(JSON.parse(String(data)), (message) => send(socket, message))
      } catch (error) {
        send(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })

  return {
    port: (wss.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        wss.clients.forEach((socket) => socket.terminate())
        wss.close(() => resolve())
      }),
  }
}
