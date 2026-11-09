// "In the background": Playwright MCP headless, on the user's Google Chrome when it's installed (nothing to install),
// else on Playwright's Chromium. Either way on a profile of Kothar's own in the space's work folder, never the user's,
// so no window opens, shows or takes focus.
//
// The session's MCP server runs this file: `node background.ts run <.browser folder> <cli.js> ...args` picks the
// browser, adds its flags, then becomes Playwright MCP. `node background.ts check` prints Chrome's path, or null.
// It runs where the session runs, so it finds the browser on that machine.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

// Google Chrome's executable, as Playwright finds it for --browser chrome, if it's there.
export function findChrome(): string | undefined {
  try {
    const mcp = dirname(require.resolve('@playwright/mcp/package.json'))
    const { registry } = require(require.resolve('playwright-core/lib/coreBundle', { paths: [mcp] }))
    const path: string | undefined = registry.registry.findExecutable('chrome')?.executablePath()
    return path && existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
}

// Chrome and Chromium can't share a profile (their versions differ), and each locks its own to one browser at a time,
// so a worker, which runs beside its space, keeps its profile in memory.
export function backgroundArgs(dir: string, chrome: boolean, worker: boolean): string[] {
  const profile = worker ? ['--isolated'] : ['--user-data-dir', join(dir, chrome ? 'chrome-profile' : 'profile')]
  return ['--browser', chrome ? 'chrome' : 'chromium', '--headless', ...profile]
}

async function main([command, ...args]: string[]) {
  if (command === 'check') {
    console.log(JSON.stringify({ chrome: findChrome() ?? null }))
    return
  }
  if (command !== 'run') throw new Error(`Unknown command ${command}`)
  const [dir, cli, ...cliArgs] = args
  if (!dir || !cli) throw new Error('Usage: background.ts run <.browser folder> <Playwright MCP cli.js> ...args')
  const extra = backgroundArgs(dir, !!findChrome(), !!process.env.KOTHAR_BROWSER_WORKER)
  process.argv = [process.argv[0]!, cli, ...cliArgs, ...extra]
  await import(pathToFileURL(cli).href)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
