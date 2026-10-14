import { CATEGORIES } from '../engine/cqx-report.js'
/** Selection of already compiled HTML, shared by the edge stitch and router.
 * These attributes never introduce data or render markup on a read. */
export function scoreCategory(url: URL, fallback?: string) {
  const wanted = url.searchParams.get('cat')
  return wanted && (CATEGORIES as readonly string[]).includes(wanted)
    ? wanted
    : fallback
}
export function selectedAttribute(
  name: string,
  value: string,
  url: URL,
  fallback?: string,
) {
  if (name === 'data-category')
    return scoreCategory(url, fallback)
      ? value === scoreCategory(url, fallback)
      : null
  if (name === 'data-glance-root')
    return value === (url.searchParams.get('in') ?? '')
  if (name === 'data-diff-path') return value === url.searchParams.get('file')
  if (name === 'data-change-overview' || name === 'data-commit-overview')
    return !url.searchParams.has('file')
  return null
}
export function selectHTML(html: string, url: URL) {
  const category = scoreCategory(
    url,
    html.match(/data-score-default="([^"]+)"/)?.[1],
  )
  return html
    .replace(
      /<(div|section)([^>]*\b(data-category|data-glance-root|data-diff-path|data-change-overview|data-commit-overview)="([^"]*)"[^>]*)>/g,
      (tag, kind, attrs, name, value) => {
        const visible = selectedAttribute(
          name,
          value.replaceAll('&amp;', '&').replaceAll('&quot;', '"'),
          url,
          category,
        )
        return visible === null
          ? tag
          : `<${kind}${attrs.replace(/ hidden(?:="")?/g, '')}${visible ? '' : ' hidden=""'}>`
      },
    )
    .replace(
      /<a([^>]*\bdata-score-category="([^"]+)"[^>]*)>/g,
      (tag, attrs, value) => {
        if (!category) return tag
        const on = attrs.match(/data-on-class="([^"]+)"/)?.[1],
          active = value === category
        if (on)
          attrs = attrs.replace(
            /class="([^"]*)"/,
            (_: string, classes: string) => {
              const names = new Set(classes.split(/\s+/).filter(Boolean))
              names.delete(on)
              if (active) names.add(on)
              return `class="${[...names].join(' ')}"`
            },
          )
        return (
          '<a' +
          attrs.replace(/aria-current="[^"]*"/, `aria-current="${active}"`) +
          '>'
        )
      },
    )
}
