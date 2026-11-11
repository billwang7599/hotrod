/**
 * The libraries a sandboxed page may load from Kothar itself, offline (the html view's libraries): served as
 * /frame/<name>.js by the dev server and written into the build next to the app. The frame's policy allows exactly
 * these URLs and nothing else of Kothar's (html-frame.tsx).
 *
 * - react: React and ReactDOM, with Sucrase to turn a page's JSX and TypeScript into JS (src/frame/react-runtime.ts).
 * - mermaid: Mermaid, then src/frame/mermaid-runtime.ts, which draws each .mermaid element.
 * - tailwind: Tailwind's browser build, which styles the page's utility classes as they appear.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { build } from 'rolldown'
import type { Plugin } from 'vite'

export const FRAME_LIBRARIES = ['react', 'mermaid', 'tailwind'] as const
export type FrameLibrary = (typeof FRAME_LIBRARIES)[number]

const here = import.meta.dirname
const resolve = createRequire(join(here, 'package.json')).resolve

async function bundle(entry: string) {
  const { output } = await build({
    input: join(here, 'src/frame', entry),
    write: false,
    platform: 'browser',
    transform: { define: { 'process.env.NODE_ENV': '"production"' } },
    output: { format: 'iife', minify: true },
  })
  return output[0].code
}

export async function frameLibrary(name: FrameLibrary): Promise<string> {
  switch (name) {
    case 'react':
      return bundle('react-runtime.ts')
    case 'mermaid':
      return `${readFileSync(resolve('mermaid/dist/mermaid.min.js'), 'utf8')}\n;${await bundle('mermaid-runtime.ts')}`
    case 'tailwind':
      return readFileSync(resolve('@tailwindcss/browser'), 'utf8')
  }
}

const PATH = /^\/frame\/([a-z]+)\.js$/

export function frameLibraries(): Plugin {
  // Built once per run, on first use.
  const built = new Map<FrameLibrary, Promise<string>>()
  const get = (name: FrameLibrary) => {
    if (!built.has(name)) built.set(name, frameLibrary(name))
    return built.get(name)!
  }
  return {
    name: 'kothar-frame-libraries',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = PATH.exec(new URL(request.url ?? '/', 'http://ui').pathname)?.[1] as FrameLibrary | undefined
        if (!name || !FRAME_LIBRARIES.includes(name)) return next()
        get(name).then(
          (code) => {
            response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
            response.end(code)
          },
          (error: unknown) => next(error),
        )
      })
    },
    async generateBundle() {
      for (const name of FRAME_LIBRARIES) this.emitFile({ type: 'asset', fileName: `frame/${name}.js`, source: await get(name) })
    },
  }
}
