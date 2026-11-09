import { memo } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyBlock } from './controls.tsx'

// Agents often write `<br>` for a line break, mostly inside table cells where Markdown has no other way to break a
// line. Raw HTML stays text (agent output is untrusted), so turn just that one tag into a real break. Code spans and
// code blocks are their own node types, so a `<br>` inside them stays literal.
type MdNode = { type: string; value?: string; children?: MdNode[] }
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

const remarkPlugins = [remarkGfm, remarkBr]

type HastNode = NonNullable<ExtraProps['node']>['children'][number]
const textOf = (node: HastNode): string =>
  'value' in node ? node.value : 'children' in node ? node.children.map(textOf).join('') : ''

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
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
