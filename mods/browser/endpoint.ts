// The address Playwright MCP is given as --cdp-endpoint: http://127.0.0.1:<port>/<token>/<space>. Playwright asks it
// for /json/version first, and only on an agent's first browser call; that's when the space's browser launches. The
// answer is the browser's own, so Playwright then talks to the browser directly over its WebSocket. After a hand-off
// the browser is a new one on a new port, and Playwright, which reconnects after a disconnect, finds it here again.
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

export type Endpoints = { url(spaceId: string): string; close(): Promise<void> }

// endpointOf: the space's running browser's DevTools endpoint, launching it if needed; it throws to refuse.
export async function serveEndpoints(endpointOf: (spaceId: string) => Promise<string>): Promise<Endpoints> {
  const token = randomBytes(18).toString('base64url')
  const server: Server = createServer(async (request, response) => {
    const [, given, spaceId, ...rest] = (request.url ?? '').split('?')[0]!.split('/')
    const path = rest.filter(Boolean).join('/')
    if (given !== token || !spaceId || !/^json(\/(version|list))?$/.test(path)) return void response.writeHead(404).end()
    try {
      const endpoint = await endpointOf(decodeURIComponent(spaceId))
      const answer = await fetch(`${endpoint}/${path}`, { signal: AbortSignal.timeout(5000) })
      response.writeHead(answer.status, { 'content-type': 'application/json' }).end(await answer.text())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      response.writeHead(503, { 'content-type': 'text/plain' }).end(message)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: (spaceId) => `http://127.0.0.1:${port}/${token}/${encodeURIComponent(spaceId)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
