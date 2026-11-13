// A tiny MCP server over stdio for tests: newline-delimited JSON-RPC, no SDK. Tools:
// - echo { text }: returns the text, and FAKE_TOKEN from its environment if set, so a test can see a secret arrive.
// - picture: a text block and an image block.
// - fail: a tool error (isError).
// - crash: exits at once, as a server that dies mid-call.
// - add_tool: adds a tool named "added" and sends notifications/tools/list_changed.
// FAKE_TOOLS (a number) adds that many more tools named many_<n>, for the token-cost warning.
// Each start appends a line to FAKE_STARTS, if set, so a test can count starts.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.env.FAKE_STARTS) appendFileSync(process.env.FAKE_STARTS, 'start\n')

const tools = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  { name: 'picture', description: 'A picture', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: 'Exits', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_tool', description: 'Adds a tool', inputSchema: { type: 'object', properties: {} } },
]
for (let i = 0; i < Number(process.env.FAKE_TOOLS ?? 0); i++) {
  tools.push({ name: `many_${i}`, description: `Tool ${i}`, inputSchema: { type: 'object', properties: {} } })
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const text = (value) => ({ content: [{ type: 'text', text: value }] })

const results = {
  initialize: (params) => ({
    protocolVersion: params?.protocolVersion ?? '2025-06-18',
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'fake', version: '1.0.0' },
  }),
  ping: () => ({}),
  'tools/list': () => ({ tools }),
  'tools/call': ({ name, arguments: args = {} }) => {
    if (name === 'echo') return text(`${args.text}${process.env.FAKE_TOKEN ? ` token=${process.env.FAKE_TOKEN}` : ''}`)
    if (name === 'picture') return { content: [{ type: 'text', text: 'see' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] }
    if (name === 'fail') return { ...text('It broke'), isError: true }
    if (name === 'crash') process.exit(3)
    if (name === 'add_tool') {
      if (!tools.some((tool) => tool.name === 'added')) {
        tools.push({ name: 'added', description: 'Added later', inputSchema: { type: 'object', properties: {} } })
      }
      setTimeout(() => send({ method: 'notifications/tools/list_changed' }), 5)
      return text('added')
    }
    if (tools.some((tool) => tool.name === name)) return text(name)
    throw Object.assign(new Error(`No tool ${name}`), { code: -32602 })
  },
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === undefined) return
  const run = results[message.method]
  if (!run) return send({ id: message.id, error: { code: -32601, message: `No method ${message.method}` } })
  try {
    send({ id: message.id, result: run(message.params) })
  } catch (error) {
    send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } })
  }
})
