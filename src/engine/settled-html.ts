import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5'
/** Resolve React's completed stream placements as data, before discarding its
 * runtime. No script execution or Flight decoding. Work happens on publication
 * (or on a private SSR response after authorization), never on a public hit. */
export function settledHTML(html: string) {
  if (!html.includes('id="S:')) return html
  const document = parse(html),
    ids = new Map<string, DefaultTreeAdapterTypes.Element>(),
    placements: [string, string, boolean][] = [],
    styles = new Set<string>()
  function visit(node: DefaultTreeAdapterTypes.Node) {
    if ('tagName' in node) {
      const id = node.attrs.find((a) => a.name === 'id')?.value
      if (id) ids.set(id, node)
      if (node.tagName === 'script') {
        const text = node.childNodes
          .map((n) => ('value' in n ? n.value : ''))
          .join('')
        for (const match of text.matchAll(
          // $RR is $RC with stylesheets to load first (newer React).
          /\$(RS|RC|RR)\("([A-Za-z]+:[0-9a-z]+)","([A-Za-z]+:[0-9a-z]+)"[,)]/g,
        )) {
          // $RR names the stylesheets its content needs; keep them as links.
          if (match[1] === 'RR')
            for (const href of text.slice(match.index! + match[0].length).match(/^\[\[.*?\]\]/)?.[0].matchAll(/"([^"]+\.css)"/g) ?? [])
              styles.add(href[1])
          placements.push(
            match[1] === 'RS'
              ? [match[3], match[2], false]
              : [match[2], match[3], true],
          )
        }
      }
      if (node.tagName === 'template' && 'content' in node)
        visit(node.content as DefaultTreeAdapterTypes.DocumentFragment)
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child)
  }
  visit(document)
  for (const [placeholder, segment, boundary] of placements) {
    const target = ids.get(placeholder),
      content = ids.get(segment),
      parent = target?.parentNode
    if (!target || !content || !parent) continue
    const at = parent.childNodes.indexOf(target)
    if (at < 0) continue
    const children = content.childNodes.splice(0)
    let end = at + 1
    // Completed Suspense boundaries replace their fallback up to the matching
    // end marker; segment placements replace only their placeholder template.
    if (boundary) {
      let depth = 1
      while (end < parent.childNodes.length) {
        const node = parent.childNodes[end]
        if (node.nodeName === '#comment' && 'data' in node) {
          if (node.data === '/$' && --depth === 0) break
          if (/^\$(?:\?|!|~)?$/.test(node.data)) depth++
        }
        end++
      }
    }
    parent.childNodes.splice(at, end - at, ...children)
    for (const child of children) child.parentNode = parent
    const owner = content.parentNode
    if (owner) {
      const index = owner.childNodes.indexOf(content)
      if (index >= 0) owner.childNodes.splice(index, 1)
    }
    content.parentNode = null
  }
  const head = document.childNodes.find((n) => n.nodeName === 'html') as DefaultTreeAdapterTypes.Element | undefined
  const headNode = head?.childNodes.find((n) => n.nodeName === 'head') as DefaultTreeAdapterTypes.Element | undefined
  if (headNode)
    for (const href of styles) {
      const linked = headNode.childNodes.some((n) => 'attrs' in n && n.attrs.some((a) => a.name === 'href' && a.value === href))
      if (!linked) {
        const link = parse(`<link rel="stylesheet" href="${href.replaceAll('"', '&quot;')}">`).childNodes[0] as DefaultTreeAdapterTypes.Element
        const element = ((link.childNodes[0] as DefaultTreeAdapterTypes.Element).childNodes[0]) as DefaultTreeAdapterTypes.Element
        element.parentNode = headNode
        headNode.childNodes.push(element)
      }
    }
  return serialize(document)
}
