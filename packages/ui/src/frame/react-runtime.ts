/**
 * Kothar's React runtime for a sandboxed page (the html view's libraries: ['react']), served as /frame/react.js and
 * bundled offline. The page's component is in <script type="text/jsx"> (or text/babel, text/tsx): this turns its JSX
 * and TypeScript into plain JS with Sucrase, runs it as an inline script (the frame's policy allows inline scripts but
 * not eval), and draws its default export into #root. Only react and react-dom can be imported; anything else throws a
 * clear error, which the page's error reporter passes on.
 */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as JsxRuntime from 'react/jsx-runtime'
import { transform } from 'sucrase'

const MODULES: Record<string, unknown> = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': JsxRuntime,
}

const SOURCES = 'script[type="text/jsx"], script[type="text/babel"], script[type="text/tsx"]'

type Module = { exports: Record<string, unknown> }
type Runtime = { require: (name: string) => unknown; module?: Module }
const runtime: Runtime = {
  require(name) {
    if (Object.hasOwn(MODULES, name)) return MODULES[name]
    throw new Error(`"${name}" can't be imported here: Kothar runs this offline, with only react and react-dom. Write it without "${name}".`)
  },
}
Object.assign(window, { React, __kothar: runtime })

/** The page's code as a CommonJS module body, its imports mapped to the runtime's. */
function compile(source: string) {
  return transform(source, { transforms: ['jsx', 'typescript', 'imports'], jsxRuntime: 'automatic', production: true }).code
}

function run() {
  const sources = [...document.querySelectorAll<HTMLScriptElement>(SOURCES)]
  if (!sources.length) return
  const module: Module = { exports: {} }
  runtime.module = module
  for (const source of sources) {
    let code: string
    try {
      code = compile(source.textContent ?? '')
    } catch (error) {
      // A syntax error: reported as the page's own, so the reporter passes it on.
      reportError(error)
      return
    }
    const script = document.createElement('script')
    script.textContent = `(function (require, module, exports) {\n${code}\n})(__kothar.require, __kothar.module, __kothar.module.exports)`
    document.body.append(script)
  }
  const exported = module.exports
  const Component = (exported.default ?? exported.App ?? Object.values(exported).find((v) => typeof v === 'function')) as
    | React.ComponentType
    | undefined
  if (typeof Component !== 'function') return
  let root = document.getElementById('root')
  if (!root) {
    root = document.createElement('div')
    root.id = 'root'
    document.body.append(root)
  }
  ReactDOMClient.createRoot(root, { onUncaughtError: (error) => reportError(error) }).render(React.createElement(Component))
}

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', run)
else run()
