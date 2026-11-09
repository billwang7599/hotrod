// Writes index.json from the files in themes/: node marketplace/build-index.ts. With --check it only says whether
// index.json is up to date, and exits 1 if it isn't.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type CatalogEntry, checkCatalog, checkTheme, MAX_THEME_BYTES, previewOf } from '../packages/core/src/shared.ts'

const DIR = fileURLToPath(new URL('.', import.meta.url))

export function buildIndex(dir = DIR) {
  const entries = readdirSync(`${dir}themes`)
    .filter((name) => name.endsWith('.json'))
    .map((name): CatalogEntry => {
      const bytes = readFileSync(`${dir}themes/${name}`)
      if (bytes.length > MAX_THEME_BYTES) throw new Error(`themes/${name} is over ${MAX_THEME_BYTES} bytes`)
      const theme = checkTheme(JSON.parse(bytes.toString('utf8')))
      if (name !== `${theme.id}.json`) throw new Error(`themes/${name} must be named ${theme.id}.json`)
      const { id, name: shown, author, description, version } = theme
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      return { id, kind: 'theme', name: shown, author, description, version, path: `themes/${name}`, sha256, preview: previewOf(theme) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  const index = { version: 1, entries }
  checkCatalog(index)
  return `${JSON.stringify(index, null, 2)}\n`
}

if (import.meta.main) {
  const built = buildIndex()
  const file = `${DIR}index.json`
  if (!process.argv.includes('--check')) writeFileSync(file, built)
  else if (readFileSync(file, 'utf8') !== built) {
    console.error('marketplace/index.json is out of date: run node marketplace/build-index.ts')
    process.exit(1)
  }
}
