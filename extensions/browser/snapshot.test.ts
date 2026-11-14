import { describe, expect, it } from 'vitest'
import { type AXNode, format, Refs, render, shortUrl } from './snapshot.ts'

// A tiny accessibility tree, as Accessibility.getFullAXTree gives one: [id, parent, role, name, props, backend id].
type Spec = [string, string | undefined, string, string?, Record<string, unknown>?, number?, { ignored?: boolean; value?: string }?]
const tree = (specs: Spec[]): AXNode[] =>
  specs.map(([nodeId, parentId, role, name, props, backend, more]) => ({
    nodeId,
    ...(parentId && { parentId }),
    role: { value: role },
    name: { value: name ?? '' },
    properties: Object.entries(props ?? {}).map(([n, value]) => ({ name: n, value: { value } })),
    childIds: specs.filter((s) => s[1] === nodeId).map((s) => s[0]),
    ...(backend !== undefined && { backendDOMNodeId: backend }),
    ...(more?.ignored && { ignored: true }),
    ...(more?.value !== undefined && { value: { value: more.value } }),
  }))

const page: Spec[] = [
  ['1', undefined, 'RootWebArea', 'Shop', { url: 'https://shop.test/cart' }, 1],
  ['2', '1', 'none', '', {}, 2, { ignored: true }],
  ['3', '2', 'navigation', 'Main', {}, 3],
  ['4', '3', 'list', '', {}, 4],
  ['5', '4', 'listitem', '', { level: 1 }, 5],
  ['6', '5', 'ListMarker', '• ', {}, 6],
  ['7', '5', 'link', 'Home', { focusable: true, url: 'https://shop.test/' }, 7],
  ['8', '7', 'StaticText', 'Home', {}, 8],
  ['9', '8', 'InlineTextBox', 'Home'],
  ['10', '2', 'main', '', {}, 10],
  ['11', '10', 'heading', 'Your cart', { level: 1 }, 11],
  ['12', '11', 'StaticText', 'Your cart', {}, 12],
  ['13', '10', 'generic', '', {}, 13],
  ['14', '13', 'LabelText', '', {}, 14],
  ['15', '14', 'StaticText', 'Coupon', {}, 15],
  ['16', '13', 'textbox', 'Coupon', { focusable: true, required: true }, 16, { value: 'SAVE10' }],
  ['17', '16', 'generic', '', {}, 17],
  ['18', '10', 'paragraph', '', {}, 18],
  ['19', '18', 'StaticText', 'Total is', {}, 19],
  ['20', '18', 'StaticText', '$12', {}, 20],
  ['21', '10', 'checkbox', 'Gift wrap', { focusable: true, checked: 'true' }, 21],
  ['22', '10', 'link', '3 comments', { focusable: true, url: 'https://elsewhere.test/c' }, 22],
  ['23', '22', 'StaticText', '3', {}, 23],
  ['24', '10', 'Iframe', 'Pay', {}, 24],
  ['25', '10', 'button', 'Expand', { focusable: true, expanded: false, disabled: true }, 25],
]

describe('render', () => {
  it('keeps what a reader needs, one line each, with refs on controls', () => {
    const refs = new Refs()
    const frame: AXNode[] = tree([
      ['1', undefined, 'RootWebArea', 'Pay', { url: 'https://pay.test/' }, 1],
      ['2', '1', 'button', 'Pay now', { focusable: true }, 7],
    ])
    const lines = format(render({ session: '', nodes: tree(page), children: new Map([[24, { session: 'S2', nodes: frame }]]) }, { refs }))
    expect(lines).toEqual([
      '- navigation "Main"',
      '  - listitem: link "Home" [e1] /',
      '- main',
      '  - heading 1 "Your cart"',
      '  - textbox "Coupon" = "SAVE10" [required] [e2]',
      '  - text "Total is $12"',
      '  - checkbox "Gift wrap" [checked] [e3]',
      '  - link "3 comments" [e4] https://elsewhere.test/c',
      '  - iframe "Pay"',
      '    - button "Pay now" [e5]',
      '  - button "Expand" [collapsed] [disabled] [e6]',
    ])
    // The iframe's button is reached through its own session.
    expect(refs.get('e5')).toEqual({ session: 'S2', backendNodeId: 7 })
    expect(refs.get('[e2]')).toEqual({ session: '', backendNodeId: 16 })
  })

  it('says when an iframe has not loaded', () => {
    const lines = format(render({ session: '', nodes: tree(page) }, { refs: new Refs() }))
    expect(lines).toContain('  - iframe "Pay" (not loaded)')
  })

  it('gives an element the same ref in every snapshot, and new ones the next', () => {
    const refs = new Refs()
    render({ session: '', nodes: tree(page) }, { refs })
    const more = tree([...page, ['30', '10', 'button', 'Checkout', { focusable: true }, 30]])
    const lines = format(render({ session: '', nodes: more }, { refs }))
    expect(lines).toContain('  - checkbox "Gift wrap" [checked] [e3]')
    expect(lines).toContain('  - button "Checkout" [e6]')
    refs.clear()
    expect(refs.get('e3')).toBeUndefined()
  })

  it('cuts very long text', () => {
    const long = 'word '.repeat(200)
    const lines = render({ session: '', nodes: tree([['1', undefined, 'RootWebArea', ''], ['2', '1', 'StaticText', long]]) }, { refs: new Refs() })
    expect(lines[0]!.text.length).toBeLessThan(420)
    expect(lines[0]!.text).toMatch(/…"$/)
  })
})

describe('shortUrl', () => {
  it('shortens addresses on the same origin to their path', () => {
    expect(shortUrl('https://a.test/x?y=1#z', 'https://a.test/page')).toBe('/x?y=1#z')
    expect(shortUrl('https://b.test/x', 'https://a.test/page')).toBe('https://b.test/x')
    expect(shortUrl('not a url', 'https://a.test/')).toBe('not a url')
  })
})
