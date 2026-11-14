// How much text agents get from the browser: Kothar's own tool list and its snapshot of Chrome's accessibility tree
// (extensions/browser/snapshot.ts), on the saved pages in fixtures/. Playwright MCP's numbers, measured before it was
// removed, are in README.md.
//
//   node bench/browser/measure.ts
//
// Not run in CI: it needs an installed Chromium-family browser (it skips without one) and launches it headless, with
// its own sandbox off so it runs inside Kothar's sandbox too, on local pages only. Tokens are estimated as characters /
// 3.57, the ratio measured for Playwright MCP's tool list (21,060 characters, about 5,900 tokens).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, type Cdp } from '../../extensions/browser/cdp.ts'
import { findBrowser } from '../../extensions/browser/profiles.ts'
import { format, readFrames, Refs, render } from '../../extensions/browser/snapshot.ts'
import { createBrowserTools } from '../../extensions/browser/tools.ts'

const TOKENS = (chars: number) => Math.round(chars / 3.57)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const PAGES = [
  { file: 'article.html', what: 'news article' },
  { file: 'form.html', what: 'checkout form' },
  { file: 'list.html', what: 'issue list (50 rows)' },
  { file: 'iframe.html', what: 'page with a sign-in iframe' },
]

const chrome = findBrowser()
if (!chrome) {
  console.log('No Chromium-family browser installed: skipped.')
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

const { tools } = createBrowserTools({ host: () => undefined, spaceIdOf: () => 's', endpointOf: async () => '', activity: () => {}, ready: () => true })
const listChars = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))).length

// Kothar's snapshot of a tab: the page's tree and each frame's.
async function ourSnapshot(cdp: Cdp, session: string, refs: Refs) {
  return format(render(await readFrames((method, params, id) => cdp.send(method, params, id), session), { refs }))
}

const rows: string[] = []
const cdp = await connect(endpoint, 30_000)
for (const page of PAGES) {
  const url = `${origin}/${page.file}`
  // Ours, on a tab of its own.
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url })
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('DOM.enable', {}, sessionId)
  await sleep(1000)
  const refs = new Refs()
  const ours = (await ourSnapshot(cdp, sessionId, refs)).join('\n')
  rows.push(
    `| ${page.what} | ${readFileSync(join(fixtures, page.file)).length.toLocaleString()} | ` +
      `${ours.length.toLocaleString()} (~${TOKENS(ours.length).toLocaleString()}) |`,
  )
  if (process.env.SHOW) console.log(`\n=== ${page.file}\n${ours}`)
}

console.log(chrome.name)
console.log(`Kothar's browser tools: ${tools.length} tools, ${listChars.toLocaleString()} characters (~${TOKENS(listChars).toLocaleString()} tokens)`)
console.log('')
console.log('| Page | HTML bytes | Kothar snapshot (tokens) |')
console.log('|---|---|---|')
for (const row of rows) console.log(row)

cdp.close()
browser.kill()
server.close()
await sleep(500)
rmSync(profile, { recursive: true, force: true })
