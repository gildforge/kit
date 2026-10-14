import type { SearchHit } from '../engine/repo-index-store.js'
import type { SearchLine } from '../engine/search-query.js'
export const fileURL = (repo: string, path: string, ref: string, line = 1) => `/${repo}?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}#L${line}`
export function MatchLine({ line }: { line: SearchLine }) {
  const parts: React.ReactNode[] = []
  let pos = 0
  for (const [start, end] of [...line.ranges].sort((a, b) => a[0] - b[0])) {
    if (end <= pos) continue
    const a = Math.max(pos, start)
    parts.push(line.text.slice(pos, a), <mark key={`${a}-${end}`}>{line.text.slice(a, end)}</mark>); pos = end
  }
  parts.push(line.text.slice(pos))
  return <><span className="search-line-number">{line.line}</span><code>{parts}</code></>
}
export function SearchHits({ hits }: { hits: SearchHit[] }) {
  return <div className="search-hits">{hits.map((hit) => <article className="search-hit" key={`${hit.repo}:${hit.ref}:${hit.path}`}>
    <a className="search-file-title" title={hit.preview} href={fileURL(hit.repo, hit.path, hit.ref, hit.lines[0].line)}><span>{hit.repo}</span> / <strong>{hit.path}</strong></a>
    <span className="search-language">{hit.language || 'Text'} · {hit.ref}</span>
    {hit.lines.map((line) => <a className="search-code-line" key={line.line} href={fileURL(hit.repo, hit.path, hit.ref, line.line)}><MatchLine line={line} /></a>)}
  </article>)}</div>
}
