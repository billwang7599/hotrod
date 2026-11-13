// How much text agents get from the browser: Playwright MCP (what the Browser extension runs today) against Kothar's own
// snapshot of Chrome's accessibility tree (extensions/browser/snapshot.ts), on the saved pages in fixtures/.
//
//   node bench/browser/measure.ts
//
// Not run in CI: it needs an installed Google Chrome (it skips without one) and launches it headless, with Chrome's
// own sandbox off so it runs inside Kothar's sandbox too, on local pages only. Tokens are estimated as characters /
// 3.57, the ratio mcp-filter.ts measured for Playwright MCP's tool list (21,060 characters, about 5,900 tokens).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, type Cdp } from '../../extensions/browser/cdp.ts'
import { HIDDEN_TOOLS } from '../../extensions/browser/mcp-filter.ts'
import { findChrome } from '../../extensions/browser/profiles.ts'
import { type AXNode, type FrameTree, format, Refs, render } from '../../extensions/browser/snapshot.ts'

const TOKENS = (chars: number) => Math.round(chars / 3.57)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const PAGES = [
  { file: 'article.html', what: 'news article' },
  { file: 'form.html', what: 'checkout form' },
  { file: 'list.html', what: 'issue list (50 rows)' },
  { file: 'iframe.html', what: 'page with a sign-in iframe' },
]

const chrome = findChrome()
if (!chrome) {
  console.log('No Google Chrome installed: skipped.')
  process.exit(0)
}

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const server = createServer((request, response) => {
  const file = join(fixtures, (request.url ?? '/').split('?')[0]!.replace(/^\/+/, ''))
  if (!file.startsWith(fixtures) || !existsSync(file)) return void response.writeHead(404).end()
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(file))
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`

const profile = mkdtempSync(join(tmpdir(), 'kothar-measure-'))
const browser = spawn(chrome.executable, [
  '--headless', '--no-sandbox', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
  '--use-mock-keychain', '--password-store=basic', 'about:blank',
], { stdio: 'ignore' })
let endpoint = ''
for (let waited = 0; !endpoint && waited < 20_000; waited += 100) {
  await sleep(100)
  try {
    endpoint = `http://127.0.0.1:${readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]}`
  } catch {}
}
if (!endpoint) throw new Error("Chrome didn't start")

// Playwright MCP over stdio, newline-delimited JSON-RPC.
const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js')
const mcp: ChildProcess = spawn(process.execPath, [cli, '--cdp-endpoint', endpoint, '--output-dir', join(profile, 'out')], {
  stdio: ['pipe', 'pipe', 'ignore'],
  // A socket path can't pass 104 bytes, and a sandboxed temp folder's can: relative to a working folder instead.
  cwd: profile,
  env: { ...process.env, TMPDIR: tmpdir(), PWTEST_SOCKETS_DIR: 's', PWTEST_SERVER_REGISTRY: join(profile, 'registry') },
})
let partial = ''
let nextId = 0
const waiting = new Map<number, (message: any) => void>()
mcp.stdout!.setEncoding('utf8')
mcp.stdout!.on('data', (chunk: string) => {
  const lines = (partial + chunk).split('\n')
  partial = lines.pop()!
  for (const line of lines.filter(Boolean)) {
    const message = JSON.parse(line)
    waiting.get(message.id)?.(message)
  }
})
const rpc = (method: string, params: object = {}) =>
  new Promise<any>((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000)
    waiting.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    })
    mcp.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
const textOf = (result: { content?: { type: string; text?: string }[] }) =>
  (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'measure', version: '0' } })
mcp.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
const { tools } = await rpc('tools/list')
const listChars = JSON.stringify(tools).length
const shown = tools.filter((t: { name: string }) => !HIDDEN_TOOLS.includes(t.name))
const shownChars = JSON.stringify(shown).length

// Kothar's snapshot of a tab: the page's tree and each frame's, by the <iframe> that holds it.
async function ourSnapshot(cdp: Cdp, session: string, refs: Refs) {
  const { frameTree } = await cdp.send<any>('Page.getFrameTree', {}, session)
  const tree = async (frame: any): Promise<FrameTree> => {
    const { nodes } = await cdp.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', { frameId: frame.frame.id }, session)
    const children = new Map<number, FrameTree>()
    for (const child of frame.childFrames ?? []) {
      const { backendNodeId } = await cdp.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: child.frame.id }, session)
      children.set(backendNodeId, await tree(child))
    }
    return { session: '', nodes, children }
  }
  return format(render(await tree(frameTree), { refs }))
}

const rows: string[] = []
const cdp = await connect(endpoint, 30_000)
for (const page of PAGES) {
  const url = `${origin}/${page.file}`
  // Playwright MCP: an action's answer (navigate here) links the snapshot it saved to a file, which the agent then
  // reads; browser_snapshot gives the same snapshot in the answer.
  const navigated = textOf(await rpc('tools/call', { name: 'browser_navigate', arguments: { url } }))
  const snapshot = textOf(await rpc('tools/call', { name: 'browser_snapshot', arguments: {} }))
  // Ours, on a tab of its own.
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url })
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('DOM.enable', {}, sessionId)
  await sleep(1000)
  const refs = new Refs()
  const ours = (await ourSnapshot(cdp, sessionId, refs)).join('\n')
  rows.push(
    `| ${page.what} | ${readFileSync(join(fixtures, page.file)).length.toLocaleString()} | ` +
      `${navigated.length.toLocaleString()} | ${snapshot.length.toLocaleString()} (~${TOKENS(snapshot.length).toLocaleString()}) | ` +
      `${ours.length.toLocaleString()} (~${TOKENS(ours.length).toLocaleString()}) | ` +
      `${Math.round((100 * ours.length) / snapshot.length)}% |`,
  )
  if (process.env.SHOW) console.log(`\n=== ${page.file} navigate\n${navigated}\n=== ${page.file} (Playwright)\n${snapshot}\n=== ${page.file} (Kothar)\n${ours}`)
}

console.log(`Playwright MCP ${JSON.parse(readFileSync(join(dirname(cli), 'package.json'), 'utf8')).version}, ${chrome.name}`)
console.log(
  `tools/list: ${tools.length} tools, ${listChars.toLocaleString()} characters (~${TOKENS(listChars).toLocaleString()} tokens); ` +
    `after mcp-filter.ts: ${shown.length} tools, ${shownChars.toLocaleString()} characters (~${TOKENS(shownChars).toLocaleString()} tokens)`,
)
console.log('')
console.log('| Page | HTML bytes | Playwright navigate answer | Playwright snapshot (tokens) | Kothar snapshot (tokens) | Kothar / Playwright |')
console.log('|---|---|---|---|---|---|')
for (const row of rows) console.log(row)

cdp.close()
mcp.kill()
browser.kill()
server.close()
await sleep(500)
rmSync(profile, { recursive: true, force: true })
