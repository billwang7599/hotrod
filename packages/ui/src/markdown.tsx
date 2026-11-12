import { memo } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyBlock } from './controls.tsx'
import { FileLink } from './file-links.tsx'
import { codeRef, fileRefsIn, type FileRef } from './file-refs.ts'

// Agents often write `<br>` for a line break, mostly inside table cells where Markdown has no other way to break a
// line. Raw HTML stays text (agent output is untrusted), so turn just that one tag into a real break. Code spans and
// code blocks are their own node types, so a `<br>` inside them stays literal.
type MdNode = { type: string; value?: string; children?: MdNode[]; data?: Record<string, unknown> }
const BR = /^<br\s*\/?>$/i
const PHRASING_PARENTS = new Set(['paragraph', 'heading', 'tableCell', 'emphasis', 'strong', 'delete', 'link'])
const brToBreak = (node: MdNode) => {
  for (const [i, child] of (node.children ?? []).entries()) {
    if (child.type === 'html' && PHRASING_PARENTS.has(node.type) && BR.test(child.value?.trim() ?? ''))
      node.children![i] = { type: 'break' }
    else brToBreak(child)
  }
}
const remarkBr = () => brToBreak

// File paths in text and whole code spans become a span marked with the path, which renders as a FileLink. Links,
// code blocks and HTML are left alone.
const refNode = ({ path, line, col }: Omit<FileRef, 'start' | 'end'>, children: MdNode[]): MdNode => ({
  type: 'fileRef',
  children,
  data: { hName: 'span', hProperties: { dataFileRef: path, dataLine: line, dataCol: col } },
})
const SKIPPED = new Set(['link', 'linkReference', 'code', 'html', 'definition', 'fileRef'])
const markRefs = (node: MdNode) => {
  if (!node.children) return
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type === 'inlineCode') {
      const ref = codeRef(child.value ?? '')
      return ref ? [refNode(ref, [child])] : [child]
    }
    if (child.type !== 'text') {
      if (!SKIPPED.has(child.type)) markRefs(child)
      return [child]
    }
    const text = child.value ?? ''
    const refs = fileRefsIn(text)
    if (!refs.length) return [child]
    const parts: MdNode[] = []
    let at = 0
    for (const ref of refs) {
      if (ref.start > at) parts.push({ type: 'text', value: text.slice(at, ref.start) })
      parts.push(refNode(ref, [{ type: 'text', value: text.slice(ref.start, ref.end) }]))
      at = ref.end
    }
    if (at < text.length) parts.push({ type: 'text', value: text.slice(at) })
    return parts
  })
}
const remarkFileRefs = () => markRefs

const remarkPlugins = [remarkGfm, remarkBr, remarkFileRefs]

const numberOf = (value: unknown) => (value === undefined || value === '' ? undefined : Number(value) || undefined)

type HastNode = NonNullable<ExtraProps['node']>['children'][number]
const textOf = (node: HastNode): string =>
  'value' in node ? node.value : 'children' in node ? node.children.map(textOf).join('') : ''

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  span: ({ node: _node, ...props }) => {
    const { 'data-file-ref': path, 'data-line': line, 'data-col': col, ...rest } = props as typeof props & Record<`data-${string}`, unknown>
    if (typeof path !== 'string') return <span {...rest} />
    return (
      <FileLink path={path} line={numberOf(line)} col={numberOf(col)}>
        {rest.children}
      </FileLink>
    )
  },
  // The renderer ends every code block with a newline the fence never had.
  pre: ({ node, ...props }) => (
    <CopyBlock className="code-block" label="Copy code" text={node ? textOf(node).replace(/\n$/, '') : ''}>
      <pre {...props} />
    </CopyBlock>
  ),
}

/** Rendered Markdown. Memoized: parsing is the costliest part of a transcript, and most texts never change. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className: string }) {
  return (
    <div className={`markdown ${className}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
