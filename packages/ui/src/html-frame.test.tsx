// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ExtensionAction, ExtensionView } from '@kothar/extension-api'
import { Tooltip } from 'radix-ui'
import { ExtensionViewer } from './extension-view.tsx'
import { FRAME_LIBRARIES, FRAME_ERROR_CHARS, FRAME_ERRORS_PER_LOAD, frameCsp, frameErrorOf, sandboxedDocument } from './html-frame.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const show = (view: ExtensionView, act_: (a: ExtensionAction) => void = () => {}) =>
  act(() =>
    root.render(
      <Tooltip.Provider>
        <ExtensionViewer view={view} act={act_} />
      </Tooltip.Provider>,
    ),
  )

const policyOf = (doc: string) => new DOMParser().parseFromString(doc, 'text/html').querySelector('meta[http-equiv]')

test('an html view runs its scripts in a sandbox of its own origin, with nothing that reaches out', () => {
  show({ type: 'html', label: 'Chart', html: '<p>Hi</p><script>parent.document.title = "x"</script>' })
  const frame = host.querySelector('iframe')!
  expect(frame.title).toBe('Chart')
  // Scripts only: no allow-same-origin (which would let it read Kothar's storage and token), no popups, forms,
  // modals or top navigation.
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.getAttribute('src')).toBeNull()
  expect(frame.getAttribute('allow')).toBe('')
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(frame.getAttribute('csp')).toBe(frameCsp())
  const doc = frame.getAttribute('srcdoc')!
  expect(doc.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
  expect(doc).toContain('<p>Hi</p>')
})

test('the policy blocks every way out by default, and web only adds loads from https:', () => {
  const strict = frameCsp()
  for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "worker-src 'none'"]) {
    expect(strict).toContain(directive)
  }
  expect(strict).not.toContain('http')
  expect(strict).toContain("script-src 'unsafe-inline';")
  expect(strict).toContain('img-src data: blob:;')
  const web = frameCsp(true)
  expect(web).toContain("script-src 'unsafe-inline' https:")
  expect(web).toContain('img-src data: blob: https:')
  // Loading a library is fine; talking to a server isn't.
  expect(web).toContain("connect-src 'none'")
  expect(web).not.toContain('http:')
})

test('the policy comes first in the page: after a doctype, before anything the page says', () => {
  const page = '<!-- made by an agent -->\n<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>'
  const doc = sandboxedDocument(page)
  expect(doc.startsWith('<!-- made by an agent -->\n<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true)
  // The page's own looser policy comes after ours; a later policy can only narrow what's allowed.
  expect(policyOf(doc)!.getAttribute('content')).toBe(frameCsp())
  // A fragment with no doctype or head still gets it first.
  expect(sandboxedDocument('<script>1</script>').startsWith('<meta')).toBe(true)
})

test('a new policy makes a new frame, since a frame reads its csp attribute once', () => {
  show({ type: 'html', label: 'A', html: '<p/>' })
  const strict = host.querySelector('iframe')!
  show({ type: 'html', label: 'A', html: '<p/>', web: true })
  const web = host.querySelector('iframe')!
  expect(web).not.toBe(strict)
  expect(web.getAttribute('csp')).toBe(frameCsp(true))
})

test('an html frame takes the room it is given, or a fixed height', () => {
  show({ type: 'stack', children: [{ type: 'heading', text: 'A' }, { type: 'html', label: 'A', html: '' }] })
  expect(host.querySelector('iframe')!.className).toContain('flex-1')
  expect((host.firstElementChild as HTMLElement).className).toContain('flex-1')
  show({ type: 'stack', children: [{ type: 'html', label: 'A', html: '', height: 200 }] })
  expect(host.querySelector('iframe')!.style.height).toBe('200px')
  expect((host.firstElementChild as HTMLElement).className).not.toContain('flex-1')
})

test('a copy view copies its text', async () => {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  show({ type: 'copy', text: '<p>Hi</p>', label: 'Copy HTML' })
  const button = host.querySelector('button')!
  expect(button.textContent).toBe('Copy HTML')
  await act(async () => button.click())
  expect(writeText).toHaveBeenCalledWith('<p>Hi</p>')
  expect(button.textContent).toBe('Copied')
})

test('a download view saves its text under its file name', () => {
  const blobs: Blob[] = []
  Object.assign(URL, { createObjectURL: (blob: Blob) => (blobs.push(blob), 'blob:x'), revokeObjectURL: () => {} })
  const clicked: HTMLAnchorElement[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this)
  })
  show({ type: 'download', text: '<p>Hi</p>', filename: 'chart.html', mimeType: 'text/html', label: 'Download' })
  act(() => host.querySelector('button')!.click())
  expect(clicked.map((a) => [a.download, a.href])).toEqual([['chart.html', 'blob:x']])
  expect(blobs[0]!.type).toBe('text/html')
})

test('with errors, a reporter runs right after the policy, before the page’s own scripts', () => {
  const doc = sandboxedDocument('<!doctype html><script>boom()</script>', { errors: true })
  const parsed = new DOMParser().parseFromString(doc, 'text/html')
  const [reporter, own] = [...parsed.querySelectorAll('script')]
  expect(reporter!.textContent).toContain('postMessage')
  expect(own!.textContent).toBe('boom()')
  expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('postMessage'))
  expect(sandboxedDocument('<p/>')).not.toContain('postMessage')
  expect(sandboxedDocument('<p/>', { theme: true })).toContain('<meta name="color-scheme" content="light dark">')
})

test('only a string from the reporter counts as an error, cut to size', () => {
  expect(frameErrorOf({ kotharFrameError: '  x is not defined ' })).toBe('x is not defined')
  expect(frameErrorOf({ kotharFrameError: 'e'.repeat(5000) })).toHaveLength(FRAME_ERROR_CHARS)
  for (const other of [null, 'text', { kotharFrameError: 3 }, { kotharFrameError: ' ' }, { other: 'x' }]) {
    expect(frameErrorOf(other)).toBeUndefined()
  }
})

test('a page’s errors go to the panel as its action, from that frame only, at most so many a load', () => {
  const sent: ExtensionAction[] = []
  show({ type: 'html', label: 'App', html: '<p/>', errors: 'error' }, (a) => sent.push(a))
  const frame = host.querySelector('iframe')!
  const post = (data: unknown, source: MessageEventSource | null = frame.contentWindow) =>
    act(() => {
      dispatchEvent(new MessageEvent('message', { data, source }))
    })
  post({ kotharFrameError: 'ReferenceError: x is not defined' })
  post({ kotharFrameError: 'from elsewhere' }, window)
  post({ kotharFrameError: 'from nowhere' }, null)
  expect(sent).toEqual([{ name: 'error', value: 'ReferenceError: x is not defined' }])
  for (let i = 0; i < FRAME_ERRORS_PER_LOAD + 5; i++) post({ kotharFrameError: `again ${i}` })
  expect(sent).toHaveLength(FRAME_ERRORS_PER_LOAD)
})

test('a plain page draws on white; a themed one on the panel, in Kothar’s scheme', () => {
  show({ type: 'html', label: 'A', html: '<p/>' })
  const plain = host.querySelector('iframe')!
  expect([plain.style.backgroundColor, plain.style.colorScheme]).toEqual(['rgb(255, 255, 255)', 'light'])
  show({ type: 'html', label: 'A', html: '<p/>', theme: true })
  const themed = host.querySelector('iframe')!
  expect(themed.style.backgroundColor).toBe('transparent')
  expect(['light', 'dark']).toContain(themed.style.colorScheme)
})

test('a page loads only the libraries Kothar serves, each by its exact URL, before its own scripts', () => {
  const origin = location.origin
  const csp = frameCsp(false, ['react', 'tailwind'])
  expect(csp).toContain(`script-src 'unsafe-inline' ${origin}/frame/react.js ${origin}/frame/tailwind.js;`)
  // Still nothing that connects, and no other path of Kothar's.
  expect(csp).toContain("connect-src 'none'")
  expect(csp).not.toContain(`${origin}/ `)
  const unknown = ['react', 'evil'] as unknown as (typeof FRAME_LIBRARIES)[number][]
  expect(frameCsp(false, unknown)).not.toContain('evil')
  const doc = sandboxedDocument('<script type="text/jsx">export default () => <p/></script>', { errors: true, libraries: ['react'] })
  const scripts = [...new DOMParser().parseFromString(doc, 'text/html').querySelectorAll('script')]
  expect(scripts.map((s) => s.getAttribute('src') ?? s.getAttribute('type') ?? 'inline')).toEqual([
    'inline',
    `${origin}/frame/react.js`,
    'text/jsx',
  ])
  show({ type: 'html', label: 'App', html: '<p/>', libraries: ['mermaid'] })
  expect(host.querySelector('iframe')!.getAttribute('csp')).toBe(frameCsp(false, ['mermaid']))
})
