/** Expand the compact stored token stream only at presentation time. Sharing
 * this between the no-JS page and router keeps anchors and geometry identical. */
export function numberLines(html: string) {
  return html.replace(/<pre class="shiki ([^"]+)"><code>([\s\S]*?)<\/code><\/pre>/g,
    (_, classes: string, body: string) => {
      let open = '', line = 1
      const start = () => `<span class="line" id="L${line}"><a href="#L${line}" class="gild-ln" aria-label="Line ${line}">${line}</a>`
      let content = start()
      for (const part of body.split(/(<i class=[a-zA-Z0-9]+>|<\/i>|\n)/)) {
        if (part === '\n') {
          content += (open ? '</i>' : '') + '</span>\n'
          line++
          content += start() + open
        } else {
          if (part.startsWith('<i class=')) open = part
          if (part === '</i>') open = ''
          content += part
        }
      }
      return `<pre class="shiki ${classes}" data-numbered=""><code>${content}</span></code></pre>`
    })
}
