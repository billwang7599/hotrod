// Lays out the folder electron-builder packs as the app (packages/desktop/build/app). Run by `npm run package` after the
// UI is built:
//
//   main.mjs       the desktop shell and the core, bundled into one file, so no workspace package sits in node_modules
//                  (Node won't strip TypeScript there)
//   preload.cjs    the window's preload
//   icon.png       the Dock icon
//   ui/            packages/ui/dist
//   mods/<id>/     the built-in mods as erasable TypeScript, without tests; the core imports each index.ts at startup,
//                  as it does from the repo
//   node_modules/  only what the built-in mods import at runtime (the Browser mod's Playwright MCP), copied from the
//                  repo's node_modules at the locked versions
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'rolldown'

const desktop = fileURLToPath(new URL('..', import.meta.url))
const repo = join(desktop, '..', '..')
const out = join(desktop, 'build', 'app')
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))

const uiDist = join(repo, 'packages', 'ui', 'dist')
if (!existsSync(join(uiDist, 'index.html'))) throw new Error('Build the UI first: npm run build -w @kothar/ui')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  input: join(desktop, 'src', 'main.ts'),
  platform: 'node',
  external: ['electron', /^node:/],
  // Bundled, every module is main.mjs, so the core's `if (import.meta.main)` command-line start (npm run dev) would run
  // a second core beside the app's own.
  transform: { define: { 'import.meta.main': 'false' } },
  output: { file: join(out, 'main.mjs'), format: 'esm', sourcemap: true },
  logLevel: 'warn',
})

cpSync(join(desktop, 'src', 'preload.cjs'), join(out, 'preload.cjs'))
cpSync(join(desktop, 'assets', 'icon.png'), join(out, 'icon.png'))
cpSync(uiDist, join(out, 'ui'), { recursive: true })

const modsSrc = join(repo, 'mods')
const runtimeDeps = {}
for (const id of readdirSync(modsSrc).sort()) {
  const dir = join(modsSrc, id)
  if (!existsSync(join(dir, 'index.ts'))) continue
  cpSync(dir, join(out, 'mods', id), {
    recursive: true,
    filter: (path) => !/\.test\.ts$/.test(path) && !path.split(/[\\/]/).includes('node_modules'),
  })
  const pkg = join(dir, 'package.json')
  if (existsSync(pkg)) Object.assign(runtimeDeps, read(pkg).dependencies)
}

// Copies a package and, depth first, every package it depends on, each from where Node would resolve it in the repo.
const copied = new Set()
function copyPackage(name, from) {
  let dir = from
  while (!existsSync(join(dir, 'node_modules', name, 'package.json'))) {
    if (dir === repo || dirname(dir) === dir) throw new Error(`${name} isn't installed; run npm install`)
    dir = dirname(dir)
  }
  const src = join(dir, 'node_modules', name)
  if (copied.has(src)) return
  copied.add(src)
  const dest = join(out, src.slice(repo.length + 1))
  cpSync(src, dest, { recursive: true, dereference: true, filter: (path) => !path.startsWith(join(src, 'node_modules')) })
  const pkg = read(join(src, 'package.json'))
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    try {
      copyPackage(dep, src)
    } catch (error) {
      if (!(dep in (pkg.optionalDependencies ?? {}))) throw error
    }
  }
}
for (const name of Object.keys(runtimeDeps)) copyPackage(name, modsSrc)

const desktopPkg = read(join(desktop, 'package.json'))
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'kothar',
      productName: desktopPkg.productName,
      version: desktopPkg.version,
      description: 'A desktop app for running coding agents',
      author: 'Bill Wang',
      license: desktopPkg.license,
      type: 'module',
      main: 'main.mjs',
      dependencies: runtimeDeps,
    },
    null,
    2,
  )}\n`,
)
console.log(`Staged the app in ${out}`)
