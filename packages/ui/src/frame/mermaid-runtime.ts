/**
 * Runs after Mermaid in /frame/mermaid.js (the html view's libraries: ['mermaid']): draws every .mermaid element as a
 * diagram, in the light or dark scheme the frame is in, with Mermaid's strict security (no HTML in labels, no clicks
 * that run scripts). A diagram that doesn't parse shows Mermaid's error and is reported as the page's error.
 */
type Mermaid = {
  initialize(config: Record<string, unknown>): void
  run(options: { querySelector: string }): Promise<void>
}

const mermaid = (globalThis as unknown as { mermaid: Mermaid }).mermaid
const dark = matchMedia('(prefers-color-scheme: dark)').matches
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'system-ui, sans-serif' })
const draw = () => mermaid.run({ querySelector: '.mermaid' }).catch((error: unknown) => reportError(error))
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', draw)
else void draw()
