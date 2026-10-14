import MarkdownIt from 'markdown-it'

// READMEs come from public repos anyone can push to, so raw HTML stays off:
// markdown-it escapes it, and its link validation refuses javascript: and
// data: URLs. This is the whole sanitising story; do not turn html on.
const md = new MarkdownIt({ html: false, linkify: true, typographer: false })

export const renderMarkdown = (source: string) => md.render(source)
