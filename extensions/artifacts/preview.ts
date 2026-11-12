import type { ExtensionView } from '@kothar/extension-api'
import type { Artifact } from './store.ts'

// How each type of artifact shows in the panel. Everything that runs is drawn in Kothar's sandboxed frame (the html
// view): scripts run, but nothing reaches Kothar, its token or the network. React and Mermaid load from Kothar itself,
// offline. Markdown and code are drawn by Kothar, no frame.

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A component's source inside a script element: </script would end it early.
const scriptSafe = (text: string) => text.replace(/<\/(script)/gi, '<\\/$1')

const PAGE_STYLE = 'html,body{margin:0}body{font-family:ui-sans-serif,system-ui,sans-serif}'

/** A React artifact as a page: its component drawn into #root, with Tailwind's classes styled. */
export const reactPage = (source: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${PAGE_STYLE}</style></head><body><div id="root"></div><script type="text/jsx">\n${scriptSafe(source)}\n</script></body></html>`

/** An SVG on a page of its own, centred and scaled down to fit. */
export const svgPage = (source: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_STYLE}body{min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box}svg{max-width:100%;height:auto}</style></head><body>${source}</body></html>`

/** A Mermaid diagram's source on a page that draws it, in Kothar's light or dark. */
export const mermaidPage = (source: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_STYLE}body{padding:16px}.mermaid{margin:0;text-align:center}.mermaid svg{max-width:100%;height:auto}</style></head><body><pre class="mermaid">${escapeHtml(source)}</pre></body></html>`

/** The language a code view colours the artifact's source in. */
export function sourceLanguage(artifact: Pick<Artifact, 'type' | 'language'>) {
  switch (artifact.type) {
    case 'html':
      return 'html'
    case 'react':
      return 'tsx'
    case 'svg':
      return 'svg'
    case 'code':
      return artifact.language
    default:
      return undefined
  }
}

/** The artifact's content drawn as it's meant to look. errors: the action a page's runtime errors come back as. */
export function previewOf(artifact: Artifact, content: string, options: { web: boolean; errors: string }): ExtensionView {
  const frame = { label: artifact.title, web: options.web, errors: options.errors }
  switch (artifact.type) {
    case 'html':
      return { type: 'html', html: content, ...frame }
    case 'react':
      return { type: 'html', html: reactPage(content), ...frame, libraries: ['tailwind', 'react'] }
    case 'svg':
      return { type: 'html', html: svgPage(content), ...frame }
    case 'mermaid':
      return { type: 'html', html: mermaidPage(content), ...frame, theme: true, libraries: ['mermaid'] }
    case 'markdown':
      return { type: 'markdown', text: content }
    case 'code':
      return { type: 'code', text: content, language: sourceLanguage(artifact), lineNumbers: true, fill: true, maxLines: 20_000 }
  }
}

/** Whether a page opened in the browser outside Kothar shows it: one that needs Kothar's libraries doesn't. */
export const opensInBrowser = (artifact: Pick<Artifact, 'type'>) => artifact.type === 'html' || artifact.type === 'svg'
