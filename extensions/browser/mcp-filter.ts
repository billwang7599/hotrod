// Playwright MCP offers its tools in groups (--caps), with no way to leave single ones out. This runs it behind a small
// stdio filter that drops some from tools/list and refuses calls to them, so agents aren't sent tools they don't need,
// and can't use the one that runs any Node code outside the browser.
//
// Measured on @playwright/mcp 0.0.84 (tools/list as JSON, no browser or model involved): 25 tools, 21,060 characters,
// about 5,900 tokens in every session that has the browser. Leaving these out saves about 3,700 characters.
export const HIDDEN_TOOLS = [
  // Runs a Playwright script in the MCP server's Node process: files, network, anything. browser_evaluate still runs
  // JavaScript in the page.
  'browser_run_code_unsafe',
  // Emulating print media or a colour scheme, dropping files onto the page and resizing the window are rarely needed,
  // and the window is never seen while agents browse.
  'browser_emulate_media',
  'browser_drop',
  'browser_resize',
]

// Run as `node -e FILTER_SCRIPT <hidden,tools> <the server's command line…>`. Lines split on \n only: JSON strings can
// hold U+2028, which readline would split on.
export const FILTER_SCRIPT = `
const { spawn } = require('node:child_process')
const [list, command, ...args] = process.argv.slice(1)
const hidden = new Set(list.split(',').filter(Boolean))
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })
const listing = new Set()
const lines = (stream, each) => {
  let partial = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    const parts = (partial + chunk).split('\\n')
    partial = parts.pop()
    for (const line of parts) each(line)
  })
  stream.on('end', () => partial && each(partial))
}
const send = (stream, line) => stream.write(line + '\\n')
lines(process.stdin, (line) => {
  let message
  try { message = JSON.parse(line) } catch { return void send(child.stdin, line) }
  if (message.method === 'tools/list' && message.id !== undefined) listing.add(message.id)
  const name = message.method === 'tools/call' ? message.params && message.params.name : undefined
  if (name && hidden.has(name)) {
    const error = { code: -32602, message: 'Tool ' + name + ' is not available in Kothar' }
    return void send(process.stdout, JSON.stringify({ jsonrpc: '2.0', id: message.id, error }))
  }
  send(child.stdin, line)
})
lines(child.stdout, (line) => {
  try {
    const message = JSON.parse(line)
    if (!message.method && listing.has(message.id) && message.result && Array.isArray(message.result.tools)) {
      listing.delete(message.id)
      message.result.tools = message.result.tools.filter((tool) => !hidden.has(tool.name))
      line = JSON.stringify(message)
    }
  } catch {}
  send(process.stdout, line)
})
process.stdin.on('end', () => child.stdin.end())
child.on('exit', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code))
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal))
`
