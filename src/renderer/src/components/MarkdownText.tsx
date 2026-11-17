import Markdown, { type Components } from 'react-markdown'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'

// remark-cjk-friendly lets **強調** work next to Japanese punctuation, e.g. 築地の**「市場」**です
// (plain CommonMark leaves the asterisks as they are there).
const remarkPlugins = [remarkGfm, remarkCjkFriendly]

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
      <Markdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
