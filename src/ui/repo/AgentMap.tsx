// Where the agents are working: the whole repo as a treemap (the same layout
// as Glance), each file in the colour of the agent whose open pull requests
// change it, deeper for more lines. A file several agents are changing is
// split on the diagonal into equal bands, one per agent, so overlaps stand
// out. Folders zoom; a file opens its diff in the busiest pull request.
import { displayIdentity } from '../../engine/channel/identity.js'
import Link from '../Link.js'
import { box, layoutRepo, tipSides } from '../../engine/treemap-layout.js'
import g from '../../render/styles/glance.module.css'

export interface AgentWork {
  name: string
  color: string
  /** path → lines changed (+ / −) and the pull request that changes it */
  files: Map<string, { adds: number; dels: number; pull: number }>
}

interface Item { path: string; lines: number; weight: number; who: { agent: AgentWork; adds: number; dels: number; pull: number }[] }

export function AgentMap({ agents, sizes, root, base, zoomHref }: {
  agents: AgentWork[]
  sizes: { path: string; lines: number }[]
  root: string
  base: string
  zoomHref: (dir: string) => string
}) {
  const known = new Set(sizes.map((s) => s.path))
  const extra = [...new Set(agents.flatMap((a) => [...a.files.keys()]))].filter((p) => !known.has(p))
  const all: Item[] = [...sizes, ...extra.map((path) => ({ path, lines: 1 }))].map((s) => {
    const who = agents.flatMap((agent) => { const w = agent.files.get(s.path); return w ? [{ agent, ...w }] : [] })
    return { ...s, weight: who.reduce((n, w) => n + w.adds + w.dels, 0), who }
  })
  if (!all.some((i) => i.weight)) return null
  const { tiles, heads, inRoot } = layoutRepo(all, root)
  const max = Math.max(1, ...inRoot.flatMap((i) => i.who.map((w) => w.adds + w.dels)))
  // Deeper for more lines, on the same square-root ramp as Glance.
  const shade = (color: string, n: number) => `color-mix(in oklab, ${color} ${Math.round(30 + 70 * Math.sqrt(n / max))}%, var(--cold))`
  const fill = (item: Item) => {
    if (!item.who.length) return undefined
    const bands = item.who.map((w) => shade(w.agent.color, w.adds + w.dels))
    if (bands.length === 1) return bands[0]
    const step = 100 / bands.length
    return `linear-gradient(135deg, ${bands.map((c, i) => `${c} ${+(i * step).toFixed(2)}% ${+((i + 1) * step).toFixed(2)}%`).join(', ')})`
  }
  const crumbs = root ? root.split('/') : []

  return (
    <section className={g.glance} aria-label="Where the agents are working" style={{ paddingTop: 0 }}>
      <h2 style={{ margin: 0, fontSize: 17 }}>Where the agents are working</h2>
      <nav className={g.crumbs} aria-label="Folder">
        <Link href={zoomHref('')} className={root ? '' : g.here}>repo</Link>
        {crumbs.map((c, i) => {
          const dir = crumbs.slice(0, i + 1).join('/')
          return <span key={dir}> / <Link href={zoomHref(dir)} className={dir === root ? g.here : ''}>{c}</Link></span>
        })}
      </nav>
      <div className={g.map} role="img" aria-label={`Treemap of ${root || 'the repo'} coloured by agent`}>
        {heads.map(({ group, rect, labelled, dir }) => (
          <div key={dir} className={`${g.folder} ${group.weight ? g.folderHot : ''}`} style={box(rect)}>
            {labelled && <Link href={zoomHref(dir)} className={g.folderHead} title={`Zoom into ${dir}/`}><span>{group.name}/</span></Link>}
          </div>
        ))}
        {tiles.map(({ item, rect, name }) => {
          const side = tipSides(rect)
          const tip = (
            <span className={`${g.tip} ${side.below ? g.tipBelow : ''} ${side.left ? g.tipLeft : ''}`} role="tooltip">
              <span className={g.tipPath}>{item.path}</span>
              {item.who.length ? item.who.map((w) => (
                <span key={w.agent.name} className={g.tipNums}>
                  <span style={{ color: w.agent.color, fontWeight: 600 }}>@{displayIdentity(w.agent.name)}</span>
                  <span className={g.tipAdd}>+{w.adds.toLocaleString()}</span>
                  <span className={g.tipDel}>−{w.dels.toLocaleString()}</span>
                  <span className={g.tipDim}>#{w.pull}</span>
                </span>
              )) : <span className={g.tipDim}>no agent is changing this</span>}
              <span className={g.tipDim}>{item.lines.toLocaleString()} lines</span>
            </span>
          )
          const style = { ...box(rect), background: fill(item) }
          const busiest = [...item.who].sort((a, b) => (b.adds + b.dels) - (a.adds + a.dels))[0]
          return busiest
            ? <Link key={item.path} href={`${base}/pulls/${busiest.pull}?tab=glance&file=${encodeURIComponent(item.path)}`} className={`${g.tile} ${g.agentTile}`} style={style}><span className={g.label}>{name}</span>{tip}</Link>
            : <div key={item.path} className={g.tile} style={{ ...box(rect), '--heat': '0%' } as React.CSSProperties}><span className={g.label}>{name}</span>{tip}</div>
        })}
      </div>
      <div className={g.legend}>
        <span className={g.hint} style={{ marginLeft: 0 }}>Size is lines in the file. Diagonal bands: several agents in one file. Click a coloured file for its diff, a folder name to zoom.</span>
      </div>
    </section>
  )
}

/** The colour key: one swatch per agent with how many files it is changing,
 *  and how many files more than one agent shares. */
export function AgentLegend({ agents }: { agents: AgentWork[] }) {
  const counts = new Map<string, number>()
  for (const a of agents) for (const p of a.files.keys()) counts.set(p, (counts.get(p) ?? 0) + 1)
  const shared = [...counts.values()].filter((n) => n > 1).length
  return (
    <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
      {agents.map((a) => (
        <span key={a.name} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: a.color, flex: 'none' }} aria-hidden />
          <strong style={{ color: a.color, fontFamily: 'var(--font-mono)', fontSize: 13 }}>@{displayIdentity(a.name)}</strong>
          <span style={{ color: 'var(--ink-dim)', marginLeft: 'auto' }}>{a.files.size} {a.files.size === 1 ? 'file' : 'files'}</span>
        </span>
      ))}
      {agents.length > 1 && (
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--ink-dim)' }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, flex: 'none', background: `linear-gradient(135deg, ${agents[0].color} 50%, ${agents[1].color} 50%)` }} aria-hidden />
          <span>shared by two or more</span>
          <span style={{ marginLeft: 'auto' }}>{shared} {shared === 1 ? 'file' : 'files'}</span>
        </span>
      )}
    </div>
  )
}
