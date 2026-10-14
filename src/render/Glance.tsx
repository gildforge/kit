// Glance: the whole repo as a treemap at a glance, lit where a change landed.
// Box size is the file's size in lines at the newer side; colour is the share
// of the change's lines that landed in that file. Untouched files stay dark so
// the shape of the repo still reads. Folders zoom; files open their diff.
import { FragmentLink as Link } from './link.js'
import type { FileDiff } from '../engine/types.js'
import { box, cleanRoot, layoutRepo, tipSides } from '../engine/treemap-layout.js'
import g from './styles/glance.module.css'

interface Item {
  path: string
  lines: number
  weight: number
  changed: number
  adds: number
  dels: number
  status?: FileDiff['status']
}

const pct = (n: number) => `${+n.toFixed(3)}%`
const share = (n: number, total: number) =>
  total ? `${Math.round((n / total) * 100) || '<1'}%` : '0%'

export { cleanRoot }

export function Glance({
  sizes,
  files,
  root,
  zoomHref,
  fileHref,
  what,
  receipts = [],
}: {
  sizes: { path: string; lines: number }[]
  files: FileDiff[]
  root: string
  zoomHref: (dir: string) => string
  fileHref: (path: string) => string
  what: string
  receipts?: import('../engine/sessions-contract.js').Receipt[]
}) {
  const read = new Set(receipts.flatMap((r) => r.files.read)),
    written = new Set(receipts.flatMap((r) => r.files.written))
  const byPath = new Map(files.map((f) => [f.path, f]))
  const total = files.reduce((n, f) => n + f.additions + f.deletions, 0)
  // Removed files no longer have a size; they take the room of what was removed.
  const all: Item[] = [
    ...sizes.map((s) => {
      const f = byPath.get(s.path)
      const changed = f ? f.additions + f.deletions : 0
      return {
        ...s,
        weight: changed,
        changed,
        adds: f?.additions ?? 0,
        dels: f?.deletions ?? 0,
        status: f?.status,
      }
    }),
    ...files
      .filter((f) => f.status === 'removed')
      .map((f) => ({
        path: f.path,
        lines: Math.max(1, f.deletions),
        weight: f.deletions,
        changed: f.deletions,
        adds: 0,
        dels: f.deletions,
        status: f.status,
      })),
  ]
  const { tiles, heads, inRoot } = layoutRepo(all, root)
  const maxChanged = Math.max(1, ...inRoot.map((i) => i.changed))
  const heat = (c: number) => (c ? 22 + 78 * Math.sqrt(c / maxChanged) : 0)

  const touched = [...files]
    .filter((f) => f.additions + f.deletions > 0)
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
  const top = touched[0]
  const dirs = new Set(
    touched.map((f) => f.path.split('/').slice(0, -1).join('/')),
  )
  const crumbs = root ? root.split('/') : []

  return (
    <div className={g.glance}>
      <div className={g.stats}>
        <span>
          <strong>{total.toLocaleString()}</strong> lines changed in this {what}
        </span>
        <span>
          <strong>{touched.length}</strong>{' '}
          {touched.length === 1 ? 'file' : 'files'} touched
        </span>
        {top && (
          <span>
            <strong>{share(top.additions + top.deletions, total)}</strong> of it
            in one file
          </span>
        )}
        <span>
          <strong>{dirs.size}</strong> {dirs.size === 1 ? 'folder' : 'folders'}
        </span>
      </div>

      <nav className={g.crumbs} aria-label="Folder">
        <Link href={zoomHref('')} className={root ? '' : g.here}>
          repo
        </Link>
        {crumbs.map((c, i) => {
          const dir = crumbs.slice(0, i + 1).join('/')
          return (
            <span key={dir}>
              {' '}
              /{' '}
              <Link href={zoomHref(dir)} className={dir === root ? g.here : ''}>
                {c}
              </Link>
            </span>
          )
        })}
      </nav>

      <div
        className={g.map}
        role="img"
        aria-label={`Treemap of ${root || 'the repo'}: ${touched.length} files changed`}
      >
        {heads.map(({ group, rect, labelled, dir }) => {
          return (
            <div
              key={dir}
              className={`${g.folder} ${group.weight ? g.folderHot : ''}`}
              style={box(rect)}
            >
              {labelled && (
                <Link
                  href={zoomHref(dir)}
                  className={g.folderHead}
                  title={`Zoom into ${dir}/`}
                >
                  <span>{group.name}/</span>
                  {group.weight > 0 && (
                    <span className={g.folderShare}>
                      {share(group.weight, total)}
                    </span>
                  )}
                </Link>
              )}
            </div>
          )
        })}
        {tiles.map(({ item, rect, name }) => {
          const style = {
            ...box(rect),
            '--heat': `${heat(item.changed)}%`,
          } as React.CSSProperties
          // The card opens away from the map's nearest edges so it never runs off the page.
          const side = tipSides(rect),
            tipSide = `${side.below ? g.tipBelow : ''} ${side.left ? g.tipLeft : ''}`
          const tip = (
            <span className={`${g.tip} ${tipSide}`} role="tooltip">
              <span className={g.tipPath}>{item.path}</span>
              {item.changed ? (
                <span className={g.tipNums}>
                  <span className={g.tipAdd}>
                    +{item.adds.toLocaleString()}
                  </span>
                  <span className={g.tipDel}>
                    −{item.dels.toLocaleString()}
                  </span>
                  <span className={g.tipDim}>
                    {share(item.changed, total)} of the change
                    {item.status && item.status !== 'modified'
                      ? ` · ${item.status}`
                      : ''}
                  </span>
                </span>
              ) : (
                <span className={g.tipDim}>unchanged</span>
              )}
              <span className={g.tipDim}>
                {item.lines.toLocaleString()} lines
              </span>
              {read.has(item.path) && (
                <span>Agent reported reading this file</span>
              )}
              {written.has(item.path) && (
                <span>Agent reported writing this file</span>
              )}
            </span>
          )
          return item.changed ? (
            <Link
              key={item.path}
              href={fileHref(item.path)}
              data-receipt-path={item.path}
              data-receipt-read={read.has(item.path)}
              data-receipt-written={written.has(item.path)}
              className={`${g.tile} ${g.hot} ${heat(item.changed) > 60 ? g.strong : ''} ${read.has(item.path) ? g.read : ''} ${written.has(item.path) ? g.written : ''}`}
              style={style}
            >
              <span className={g.label}>{name}</span>
              {tip}
            </Link>
          ) : (
            <div
              key={item.path}
              data-receipt-path={item.path}
              data-receipt-read={read.has(item.path)}
              data-receipt-written={written.has(item.path)}
              className={`${g.tile} ${read.has(item.path) ? g.read : ''} ${written.has(item.path) ? g.written : ''}`}
              style={style}
            >
              <span className={g.label}>{name}</span>
              {tip}
            </div>
          )
        })}
      </div>

      {receipts.length > 0 && (
        <p className={g.receiptLegend}>
          Session overlay: dotted outline = reported read; solid outline =
          reported write. File heat still shows the actual change.
        </p>
      )}
      <div className={g.legend}>
        <span>0%</span>
        <span className={g.ramp} aria-hidden />
        <span>
          {top ? share(top.additions + top.deletions, total) : '0%'} of the
          change
        </span>
        <span className={g.hint}>
          Size is lines in the file. Click a lit file for its diff, a folder
          name to zoom.
        </span>
      </div>

      {touched.length > 0 && (
        <section className={g.where}>
          <h3>Where the work went</h3>
          {touched.slice(0, 8).map((f) => {
            const n = f.additions + f.deletions
            const at = f.path.lastIndexOf('/')
            return (
              <Link key={f.path} href={fileHref(f.path)} className={g.row}>
                <span className={g.file}>
                  <span className={g.dim}>{f.path.slice(0, at + 1)}</span>
                  {f.path.slice(at + 1)}
                </span>
                <span className={g.bar}>
                  <span
                    style={{
                      width: pct((n / (top.additions + top.deletions)) * 100),
                    }}
                  />
                </span>
                <span className={g.num}>{share(n, total)}</span>
              </Link>
            )
          })}
        </section>
      )}
    </div>
  )
}
