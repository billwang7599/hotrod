// A page as agents read it: Chrome's accessibility tree (Accessibility.getFullAXTree), trimmed to what a reader needs.
// Wrappers with no name of their own (generic, none, paragraph, the ignored ones) give way to their children; a
// control's own text, the text boxes inside an input and list bullets go; what's left is one line per thing, indented
// under the landmark, list item, row or dialog it's in. Each control gets a short ref (e12) that stays the same for the
// same element while the tab lives, so browser_act can name it; the ref maps to the element's backendDOMNodeId in its
// frame's session. Plain data in and text out (readFrames takes the CDP call as a parameter), so it can be tested without
// a browser.

export type AXValue = { type?: string; value?: unknown }
export type AXProperty = { name: string; value: AXValue }
export type AXNode = {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: AXProperty[]
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
  frameId?: string
}

// One frame's tree, and the frames inside it, by the backendDOMNodeId of the <iframe> that holds each. session: the
// CDP session the frame's elements are reached through (a cross-site iframe has its own); '' for the page's.
export type FrameTree = { session: string; nodes: AXNode[]; children?: Map<number, FrameTree> }

// What a ref points at.
export type RefTarget = { session: string; backendNodeId: number }

// Refs for one tab: the same element keeps its ref across snapshots, so an agent's earlier refs still work after the
// page changes around them. New elements get the next number.
export class Refs {
  private next = 1
  private byKey = new Map<string, string>()
  private byRef = new Map<string, RefTarget>()
  of(target: RefTarget): string {
    const key = `${target.session}:${target.backendNodeId}`
    let ref = this.byKey.get(key)
    if (!ref) {
      ref = `e${this.next++}`
      this.byKey.set(key, ref)
      this.byRef.set(ref, target)
    }
    return ref
  }
  get(ref: string): RefTarget | undefined {
    return this.byRef.get(ref.replace(/^\[|\]$/g, ''))
  }
  // A new document: every element is new, and old refs must not reach the elements that happen to reuse their ids.
  clear() {
    this.byKey.clear()
    this.byRef.clear()
  }
}

// Roles that are something to act on, so they get a ref (and anything focusable does too).
const CONTROLS = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'scrollbar', 'gridcell',
  'columnheader', 'rowheader', 'textField', 'TextField', 'PopUpButton', 'ToggleButton', 'disclosureTriangle',
  'DisclosureTriangle', 'video', 'audio', 'Video', 'Audio',
])
// Left out with everything under them.
const DROPPED = new Set(['InlineTextBox', 'ListMarker', 'LineBreak', 'presentation'])
// Give way to their children unless they have a name.
const WRAPPERS = new Set([
  'none', 'generic', 'GenericContainer', 'LabelText', 'paragraph', 'Section', 'group', 'div', 'Div', 'Pre', 'time',
  'Abbr', 'Ruby', 'emphasis', 'strong', 'subscript', 'superscript', 'mark', 'code', 'deletion', 'insertion', 'blockquote',
  'Canvas', 'figure', 'Figcaption', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell', 'list', 'DescriptionList',
  'term', 'definition', 'DescriptionListTerm', 'DescriptionListDetail', 'form', 'search', 'article', 'region', 'log',
  'status', 'note', 'Legend', 'legend', 'caption', 'superscript', 'sectionheader', 'sectionfooter',
])
// Roles whose children are its own text or text boxes: shown on the one line.
const LEAVES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'image', 'img', 'option', 'checkbox', 'radio', 'switch', 'progressbar', 'meter'])

const ROLE_NAMES: Record<string, string> = { RootWebArea: 'page', Iframe: 'iframe', IframePresentational: 'iframe', img: 'image', StaticText: 'text' }

// Longest name or text on one line, in characters; the rest is cut with an ellipsis.
const MAX_NAME = 400
// Passed down as the parent's name from a named control: text inside it is part of that name (or its label instead).
const CONTROL_TEXT = '\u0000control'

export type Line = { depth: number; text: string }

const prop = (node: AXNode, name: string) => node.properties?.find((p) => p.name === name)?.value?.value
const str = (value: unknown) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
const clip = (text: string) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > MAX_NAME ? `${one.slice(0, MAX_NAME - 1)}…` : one
}
const quote = (text: string) => JSON.stringify(clip(text))

// A link's address, short: the path alone when it's on the page's own origin.
export function shortUrl(url: string, base?: string) {
  if (!base) return url
  try {
    const at = new URL(url)
    const from = new URL(base)
    if (at.origin !== from.origin || at.protocol === 'file:') return url
    return `${at.pathname}${at.search}${at.hash}` || '/'
  } catch {
    return url
  }
}

export type RenderOptions = { refs: Refs }

// The lines of a frame's tree (and the frames in it), from its root's children down.
export function render(frame: FrameTree, options: RenderOptions): Line[] {
  const lines: Line[] = []
  walkFrame(frame, 0, options, lines)
  return lines
}

function walkFrame(frame: FrameTree, depth: number, options: RenderOptions, lines: Line[]) {
  const byId = new Map(frame.nodes.map((n) => [n.nodeId, n]))
  const root = frame.nodes.find((n) => !n.parentId || !byId.has(n.parentId))
  if (!root) return
  const base = str(prop(root, 'url'))
  let lastText: { line: Line; parent: string | undefined; whole: string } | undefined
  const controlNames = new Set(frame.nodes.filter((n) => CONTROLS.has(str(n.role?.value))).map((n) => str(n.name?.value).trim()))
  const visit = (node: AXNode, depth: number, parentName: string) => {
    const role = str(node.role?.value)
    if (DROPPED.has(role)) return
    const children = () => (node.childIds ?? []).map((id) => byId.get(id)).filter((n): n is AXNode => !!n)
    const name = str(node.name?.value).trim()
    if (role === 'StaticText') {
      // A control's own text is already its name.
      if (!name || name === parentName || parentName === CONTROL_TEXT) return
      // A <label>'s text is the name of the field it labels, on that field's own line.
      if (byId.get(node.parentId ?? '')?.role?.value === 'LabelText' && controlNames.has(name)) return
      // Text of one element split into pieces (by a <b>, say) reads as one line when nothing came between.
      const last = lines.at(-1)
      if (last && last === lastText?.line && lastText.parent === node.parentId) {
        lastText.whole = `${lastText.whole} ${name}`
        last.text = `text ${quote(lastText.whole)}`
        return
      }
      const line = { depth, text: `text ${quote(name)}` }
      lines.push(line)
      lastText = { line, parent: node.parentId, whole: name }
      return
    }
    if (role === 'Iframe' || role === 'IframePresentational') {
      const inner = node.backendDOMNodeId === undefined ? undefined : frame.children?.get(node.backendDOMNodeId)
      lines.push({ depth, text: `iframe${name ? ` ${quote(name)}` : ''}${inner ? '' : ' (not loaded)'}` })
      if (inner) walkFrame(inner, depth + 1, options, lines)
      return
    }
    const focusable = prop(node, 'focusable') === true
    const control = CONTROLS.has(role) || (focusable && role !== 'RootWebArea' && !node.ignored && !WRAPPERS.has(role))
    if (node.ignored || (WRAPPERS.has(role) && !name && !control) || role === 'RootWebArea') {
      for (const child of children()) visit(child, depth, parentName)
      return
    }
    const parts = [ROLE_NAMES[role] ?? role]
    if (role === 'heading') parts[0] = `heading${prop(node, 'level') ? ` ${str(prop(node, 'level'))}` : ''}`
    if (name) parts.push(quote(name))
    const value = str(node.value?.value)
    if (value && value !== name) parts.push(`= ${quote(value)}`)
    for (const flag of ['checked', 'pressed', 'selected', 'expanded']) {
      const on = prop(node, flag)
      if (on === true || on === 'true') parts.push(`[${flag}]`)
      else if (on === 'mixed') parts.push(`[${flag}=mixed]`)
      else if (flag === 'expanded' && (on === false || on === 'false')) parts.push('[collapsed]')
    }
    if (prop(node, 'disabled') === true) parts.push('[disabled]')
    if (prop(node, 'required') === true) parts.push('[required]')
    if (prop(node, 'focused') === true) parts.push('[focused]')
    if (control && node.backendDOMNodeId !== undefined) {
      parts.push(`[${options.refs.of({ session: frame.session, backendNodeId: node.backendDOMNodeId })}]`)
    }
    if (role === 'link') {
      const url = str(prop(node, 'url'))
      if (url) parts.push(shortUrl(url, base))
    }
    const at = lines.length
    lines.push({ depth, text: parts.join(' ') })
    if (LEAVES.has(role)) return
    for (const child of children()) visit(child, depth + 1, control && name ? CONTROL_TEXT : name)
    // A container with one line under it says it on its own line: "listitem: link "World" [e3]".
    const under = lines.length - at - 1
    if (under === 1 && !control && !name) {
      const only = lines.pop()!
      lines[at]!.text = `${lines[at]!.text}: ${only.text}`
    } else if (under === 0 && !control && !name && role !== 'separator') {
      lines.pop()
    }
  }
  for (const child of (root.childIds ?? []).map((id) => byId.get(id)).filter((n): n is AXNode => !!n)) visit(child, depth, '')
}

export const format = (lines: Line[]) => lines.map((l) => `${'  '.repeat(l.depth)}- ${l.text}`)

// A CDP call, as CdpClient.send makes it; a parameter so the frame reading below can be tested with a fake.
export type Send = (method: string, params?: object, sessionId?: string) => Promise<any>

type FrameNode = { frame: { id: string; url?: string }; childFrames?: FrameNode[] }

// Frames inside frames are read this deep, no deeper.
const MAX_FRAME_DEPTH = 6

// Reads a tab's tree and every frame's in it: a same-site iframe through the tab's own session (by its frame id), a
// cross-site one through the session its own target was attached on (children: frame id → session). An iframe whose
// tree can't be read is left out, and shows as not loaded.
export async function readFrames(send: Send, sessionId: string, children: Map<string, string> = new Map()): Promise<FrameTree> {
  const read = async (node: FrameNode, session: string, own: boolean, depth: number): Promise<FrameTree> => {
    // A frame with a session of its own is that session's root: its tree is read without a frame id.
    const { nodes } = await send('Accessibility.getFullAXTree', own ? {} : { frameId: node.frame.id }, session)
    const tree: FrameTree = { session, nodes, children: new Map() }
    if (depth >= MAX_FRAME_DEPTH) return tree
    for (const child of node.childFrames ?? []) {
      try {
        const { backendNodeId } = await send('DOM.getFrameOwner', { frameId: child.frame.id }, session)
        const childSession = children.get(child.frame.id)
        if (childSession) {
          const { frameTree } = await send('Page.getFrameTree', {}, childSession)
          tree.children!.set(backendNodeId, await read(frameTree, childSession, true, depth + 1))
        } else {
          tree.children!.set(backendNodeId, await read(child, session, false, depth + 1))
        }
      } catch {
        // Gone, or not ready: shown as not loaded.
      }
    }
    return tree
  }
  const { frameTree } = await send('Page.getFrameTree', {}, sessionId)
  return read(frameTree, sessionId, true, 0)
}

// The default size of one snapshot, in characters (about 3,400 tokens); a longer page goes on with a cursor.
export const SNAPSHOT_CHARS = 12_000

// The lines from cursor on that fit in maxChars (at least one), and the cursor for the rest, if any.
export function paginate(lines: string[], { cursor = 0, maxChars = SNAPSHOT_CHARS }: { cursor?: number; maxChars?: number } = {}) {
  const from = Math.max(0, Math.min(cursor, lines.length))
  let size = 0
  let to = from
  while (to < lines.length && (to === from || size + lines[to]!.length + 1 <= maxChars)) size += lines[to++]!.length + 1
  return { lines: lines.slice(from, to), ...(to < lines.length && { next: to }), total: lines.length }
}

// What changed between two snapshots of a tab: the lines that are new, each marked "+", under the lines they sit in
// (unmarked, for context), and how many lines went. Lines are compared whole, refs and all, so an element that only
// moved shows as new where it is now.
export function changes(before: string[], after: string[]): { lines: string[]; added: number; removed: number } {
  const left = new Map<string, number>()
  for (const line of before) left.set(line, (left.get(line) ?? 0) + 1)
  const added = new Set<number>()
  after.forEach((line, i) => {
    const count = left.get(line) ?? 0
    if (count) left.set(line, count - 1)
    else added.add(i)
  })
  const removed = [...left.values()].reduce((a, b) => a + b, 0)
  const depthOf = (line: string) => line.length - line.trimStart().length
  const shown = new Set<number>()
  const lines: string[] = []
  for (const i of [...added].sort((a, b) => a - b)) {
    // Its parents, nearest last, that aren't shown yet.
    const context: number[] = []
    let depth = depthOf(after[i]!)
    for (let j = i - 1; j >= 0 && depth > 0; j--) {
      if (depthOf(after[j]!) < depth) {
        depth = depthOf(after[j]!)
        if (!shown.has(j) && !added.has(j)) context.unshift(j)
        else break
      }
    }
    for (const j of context) {
      shown.add(j)
      lines.push(` ${after[j]}`)
    }
    shown.add(i)
    lines.push(`+${after[i]}`)
  }
  return { lines, added: added.size, removed }
}
