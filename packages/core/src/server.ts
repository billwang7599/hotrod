import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import type { Core } from './core.ts'
import { BAD_TOKEN_CLOSE_CODE, IMAGE_TYPES, type CoreMessage } from './shared.ts'

// Hashing first gives equal lengths, which timingSafeEqual needs, without leaking the token's length.
const digest = (text: string) => createHash('sha256').update(text).digest()
const sameToken = (given: string, token: string) => timingSafeEqual(digest(given), digest(token))

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const ATTACHMENT_PATH = /^\/chats\/([^/]+)\/attachments\/([^/]+)$/
const EXTENSION_FILE_PATH = /^\/extensions\/([a-z0-9-]+)\/files$/

export async function startServer(options: {
  core: Core
  port: number
  uiOrigin: string
  token: string
  uiDir?: string
}) {
  const { core, port, uiOrigin, token } = options
  const uiDir = options.uiDir && resolve(options.uiDir)
  const serveUi: RequestListener = (request, response) => {
    if (!uiDir) return response.writeHead(426).end()
    const index = join(uiDir, 'index.html')
    let file = join(uiDir, new URL(request.url ?? '/', 'http://ui').pathname)
    if (!file.startsWith(uiDir + sep) || !existsSync(file) || !statSync(file).isFile()) file = index
    if (!existsSync(file)) return response.writeHead(404).end(`No UI build in ${uiDir}`)
    response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(response)
  }
  let serveMcp: ReturnType<Core['serveMcp']> | undefined
  const http = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://core')
    if (serveMcp && url.pathname === '/mcp') {
      return void serveMcp(request, response).catch(() => response.headersSent || response.writeHead(500).end())
    }
    const attachment = url.pathname.match(ATTACHMENT_PATH)
    if (attachment) {
      if (!sameToken(url.searchParams.get('token') ?? '', token)) return response.writeHead(401).end()
      let found
      try {
        found = core.attachment(decodeURIComponent(attachment[1]!), decodeURIComponent(attachment[2]!))
      } catch {}
      if (!found || !existsSync(found.path)) return response.writeHead(404).end()
      // The UI shares this origin in the desktop app, so nothing but a plain image or a PDF may render here.
      const inline = [...IMAGE_TYPES, 'application/pdf'].includes(found.mimeType)
      response.writeHead(200, {
        'content-type': inline ? found.mimeType : 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
        'access-control-allow-origin': uiOrigin,
        ...(!inline && { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.name)}` }),
      })
      return void createReadStream(found.path).pipe(response)
    }
    // A picture from an extension's own folders (core.extensionFile), such as one pasted into a note.
    const extensionFile = url.pathname.match(EXTENSION_FILE_PATH)
    if (extensionFile) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response.writeHead(405).end()
      if (!sameToken(url.searchParams.get('token') ?? '', token)) return response.writeHead(401).end()
      const found = core.extensionFile(extensionFile[1]!, url.searchParams.get('path') ?? '')
      if (!found) return response.writeHead(404).end()
      response.writeHead(200, {
        'content-type': found.mimeType,
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
        'cache-control': 'no-cache',
        'access-control-allow-origin': uiOrigin,
      })
      if (request.method === 'HEAD') return response.end()
      return void createReadStream(found.path).pipe(response)
    }
    serveUi(request, response)
  })
  const wss = new WebSocketServer({
    server: http,
    verifyClient: (info, accept) => accept(info.origin === uiOrigin, 403, 'Origin not allowed'),
  })
  const send = (socket: WebSocket, message: CoreMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  core.onMessage((message) => wss.clients.forEach((socket) => send(socket, message)))

  wss.on('connection', (socket, request) => {
    const given = new URL(request.url ?? '/', 'ws://core').searchParams.get('token') ?? ''
    if (!sameToken(given, token)) return socket.close(BAD_TOKEN_CLOSE_CODE, 'Missing or wrong token')
    send(socket, {
      type: 'snapshot',
      engines: core.engines(),
      chats: core.chats(),
      accounts: core.accounts(),
      contextDefaults: core.contextDefaults(),
      extensions: core.extensions(),
      modelLists: core.modelLists(),
      setups: core.setups(),
      memory: core.memory(),
      workers: core.workers(),
      workFolder: core.workFolder(),
      themes: core.themes(),
      installed: core.installed(),
      communityExtensions: core.communityExtensions(),
      restart: core.restart(),
    })
    socket.on('message', (data) => {
      try {
        core.handle(JSON.parse(String(data)), (message) => send(socket, message))
      } catch (error) {
        send(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    // ws re-emits the http server's errors on wss, where they'd go uncaught without a listener.
    wss.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') return reject(error)
      reject(new Error(`Port ${port} is in use. Is Kothar already running? Set KOTHAR_PORT to use another port.`))
    })
    http.listen(port, '127.0.0.1', resolve)
  })

  const { port: boundPort } = http.address() as AddressInfo
  serveMcp = core.serveMcp(`http://127.0.0.1:${boundPort}/mcp`)
  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        wss.clients.forEach((socket) => socket.terminate())
        wss.close()
        http.closeAllConnections()
        http.close(() => resolve())
      }),
  }
}
