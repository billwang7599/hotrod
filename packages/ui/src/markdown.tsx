import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyBlock } from './controls.tsx'

const remarkPlugins = [remarkGfm]

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

export function Markdown({ text, className }: { text: string; className: string }) {
  return (
    <div className={`markdown ${className}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
