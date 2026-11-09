// Agent tabs sit in a Chrome tab group named for Kothar, in the modes with a window. Chrome lets only extensions make
// tab groups; neither CDP nor Playwright can.
//
// - Your Chrome, in front: the Playwright Extension already puts each connection's tabs in a group of its own,
//   "Playwright · <MCP client name>". The engine is the MCP client, so the group would say "claude-code".
//   `node group.ts name <cli.js> ...args` runs Playwright MCP with the client named Kothar: "Playwright · Kothar".
// - Kothar's Chromium, in a window: Playwright's Chromium still loads unpacked extensions (branded Chrome 137 and
//   later doesn't), and every tab in it is the agent's. `node group.ts window <.browser folder> <cli.js> ...args`
//   loads ./extension, which groups each tab as "Kothar".
// - Your open browser (debugging port): nothing groups its tabs; see the mod's status line.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const GROUP_NAME = 'Kothar'
export const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), 'extension')

// The MCP initialize request with its client renamed; any other line as it is.
export function renameClient(line: string, name = GROUP_NAME): string {
  if (!line.includes('"initialize"')) return line
  try {
    const message = JSON.parse(line)
    if (message?.method !== 'initialize' || typeof message.params?.clientInfo !== 'object') return line
    message.params.clientInfo = { ...message.params.clientInfo, name }
    return JSON.stringify(message)
  } catch {
    return line
  }
}

// Playwright MCP's config for Kothar's Chromium with the grouping extension. Playwright passes --disable-extensions
// unless told not to.
export function windowConfig(extension = EXTENSION_DIR) {
  return {
    browser: {
      launchOptions: {
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
        ignoreDefaultArgs: ['--disable-extensions'],
      },
    },
  }
}

// Chromium loads extensions only into a profile on disk, so a worker's --isolated (a profile in memory) becomes a
// profile of its own in the .browser folder, removed when its session ends. Its space's profile is locked by its
// space's browser.
export function windowArgs(dir: string, cliArgs: string[]): { args: string[]; temporary?: string } {
  if (!cliArgs.includes('--isolated')) return { args: cliArgs }
  mkdirSync(dir, { recursive: true })
  const temporary = mkdtempSync(join(dir, 'worker-'))
  return { args: [...cliArgs.filter((arg) => arg !== '--isolated'), '--user-data-dir', temporary], temporary }
}

// Runs Playwright MCP as a child, renaming the client in the initialize request on its way in. Messages are lines;
// split on \n only, since JSON strings can hold U+2028.
function runNamed(cli: string, args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ['pipe', 'inherit', 'inherit'] })
  let partial = ''
  let renamed = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    if (renamed) return void child.stdin.write(chunk)
    const lines = (partial + chunk).split('\n')
    partial = lines.pop()!
    for (const line of lines) {
      const out: string = renamed ? line : renameClient(line)
      renamed ||= out !== line
      child.stdin.write(out + '\n')
    }
    if (renamed && partial) {
      child.stdin.write(partial)
      partial = ''
    }
  })
  process.stdin.on('end', () => child.stdin.end(partial))
  child.stdin.on('error', () => {})
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

async function main([command, ...args]: string[]) {
  if (command === 'name') {
    const [cli, ...cliArgs] = args
    if (!cli) throw new Error('Usage: group.ts name <Playwright MCP cli.js> ...args')
    return runNamed(cli, cliArgs)
  }
  if (command !== 'window') throw new Error(`Unknown command ${command}`)
  const [dir, cli, ...cliArgs] = args
  if (!dir || !cli) throw new Error('Usage: group.ts window <.browser folder> <Playwright MCP cli.js> ...args')
  mkdirSync(dir, { recursive: true })
  const config = join(dir, 'window-config.json')
  writeFileSync(config, JSON.stringify(windowConfig(), null, 2))
  const { args: launch, temporary } = windowArgs(dir, cliArgs)
  if (temporary) process.on('exit', () => rmSync(temporary, { recursive: true, force: true }))
  process.argv = [process.argv[0]!, cli, ...launch, '--config', config]
  await import(pathToFileURL(cli).href)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
