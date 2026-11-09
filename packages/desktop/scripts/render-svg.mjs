// Renders SVGs to PNGs in headless Chromium: node render-svg.mjs <in.svg>:<out.png>:<size> ...
// Uses the repo's Playwright. If its own browser isn't installed, point CHROME at any Chromium or Chrome binary.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined })
for (const job of process.argv.slice(2)) {
  const [input, output, size] = job.split(':')
  const px = Number(size)
  const src = `data:image/svg+xml;base64,${readFileSync(input).toString('base64')}`
  const page = await browser.newPage({ viewport: { width: px, height: px } })
  await page.setContent(`<body style="margin:0"><img src="${src}" width="${px}" height="${px}" style="display:block"></body>`)
  await page.waitForFunction(() => document.images[0].complete)
  await page.screenshot({ path: output, omitBackground: true })
  await page.close()
}
await browser.close()
