import { isValidElement, useRef, type ComponentProps } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import { CopyButton } from './CopyButton'

// remark-cjk-friendly lets **強調** work next to Japanese punctuation, e.g. 築地の**「市場」**です
// (plain CommonMark leaves the asterisks as they are there).
// remark-breaks keeps a single line break as a line break, as chat apps (and Claude.ai) show it;
// plain Markdown would join the lines.
const remarkPlugins = [remarkGfm, remarkCjkFriendly, remarkBreaks]

/** A code block with its language and a copy button above it. */
function CodeBlock(props: ComponentProps<'pre'> & { node?: unknown }) {
  const { node, children, ...rest } = props
  void node
  const ref = useRef<HTMLPreElement>(null)
  const className = isValidElement<{ className?: string }>(children) ? (children.props.className ?? '') : ''
  const language = /language-([\w+#.-]+)/.exec(className)?.[1] ?? ''
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-language">{language}</span>
        <CopyButton getText={() => ref.current?.textContent ?? ''} />
      </div>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
    </div>
  )
}

// Links open in the default browser (the main process routes window.open there).
// Raw HTML in replies is not rendered; react-markdown escapes it.
const components: Components = {
  a(props) {
    const { node, ...rest } = props
    void node
    return <a {...rest} target="_blank" rel="noreferrer" />
  },
  pre: CodeBlock,
}

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
