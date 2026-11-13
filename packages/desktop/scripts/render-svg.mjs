// Renders SVGs to PNGs in headless Chrome: node render-svg.mjs <in.svg>:<out.png>:<size> ...
// Uses the installed Google Chrome; point CHROME at any other Chromium-family binary. CHROME_ARGS: more flags, space
// separated (--no-sandbox inside a sandbox).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const tmp = mkdtempSync(join(tmpdir(), 'render-svg-'))
try {
  for (const job of process.argv.slice(2)) {
    const [input, output, size] = job.split(':')
    const px = Number(size)
    const src = `data:image/svg+xml;base64,${readFileSync(input).toString('base64')}`
    const page = join(tmp, 'page.html')
    writeFileSync(page, `<body style="margin:0"><img src="${src}" width="${px}" height="${px}" style="display:block"></body>`)
    execFileSync(chrome, [
      '--headless',
      ...(process.env.CHROME_ARGS?.split(' ').filter(Boolean) ?? []),
      `--user-data-dir=${join(tmp, 'profile')}`,
      '--no-first-run',
      '--hide-scrollbars',
      `--window-size=${px},${px}`,
      '--default-background-color=00000000',
      `--screenshot=${output}`,
      pathToFileURL(page).href,
    ], { stdio: 'ignore' })
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
