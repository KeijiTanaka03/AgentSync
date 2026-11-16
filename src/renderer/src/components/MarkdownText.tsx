import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Links open in the default browser (the main process routes window.open there).
// Raw HTML in replies is not rendered; react-markdown escapes it.
const components: Components = {
  a(props) {
    const { node, ...rest } = props
    void node
    return <a {...rest} target="_blank" rel="noreferrer" />
  },
}

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
