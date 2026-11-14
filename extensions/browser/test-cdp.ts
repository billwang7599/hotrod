// For tests: a fake browser that speaks the DevTools protocol, with a handler the test writes. Never a real Chrome.
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

export type Handler = (method: string, params: any, sessionId: string | undefined, peer: Peer) => unknown
export type Peer = { emit(method: string, params: object, sessionId?: string): void; calls: { method: string; params: any; sessionId?: string }[]; drop(): void }

// A fake browser: a DevTools endpoint whose /json/version points at a WebSocket that answers with handler.
export async function fakeBrowser(handler: Handler) {
  let socket: WebSocket | undefined
  const calls: Peer['calls'] = []
  const peer: Peer = {
    emit: (method, params, sessionId) => socket?.send(JSON.stringify({ method, params, ...(sessionId && { sessionId }) })),
    calls,
    drop: () => socket?.terminate(),
  }
  const server = createServer((request, response) => {
    if (request.url !== '/json/version') return void response.writeHead(404).end()
    const { port } = server.address() as { port: number }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }))
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws) => {
    socket = ws
    ws.on('message', async (data) => {
      const { id, method, params, sessionId } = JSON.parse(String(data))
      calls.push({ method, params, ...(sessionId && { sessionId }) })
      try {
        const result = await handler(method, params, sessionId, peer)
        if (result === 'never') return
        ws.send(JSON.stringify({ id, result: result ?? {}, ...(sessionId && { sessionId }) }))
      } catch (error) {
        ws.send(JSON.stringify({ id, error: { code: -32000, message: (error as Error).message } }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const close = () => new Promise<void>((resolve) => (wss.close(), server.closeAllConnections(), server.close(() => resolve())))
  const { port } = server.address() as { port: number }
  return { endpoint: `http://127.0.0.1:${port}`, peer, close }
}

