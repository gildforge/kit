import type { Commit as CommitRecord } from '../engine/types.js'
import type { Change } from '../engine/types.js'
import type { Report } from '../engine/cqx-report.js'
import { cleanRoot } from '../engine/treemap-layout.js'
import { Glance } from './Glance.js'
import { HealthReview } from './Health.js'
import { FileView } from './Diff.js'
import s from './styles/repo.module.css'

export function Score({
  report,
  sha,
  before,
  review,
}: {
  report: Report | null
  sha: string
  before?: Report | null
  review?: boolean
}) {
  return report ? (
    <HealthReview
      report={report}
      picked={null}
      allCategories
      pickHref={(c) => `?ref=__GILD_REF__&cat=${c}#score`}
      before={before}
      beforeName="its parent"
      title={
        review ? (
          'cqx review of this commit'
        ) : (
          <>
            Code Score of <span data-ref-label="" /> at {sha.slice(0, 7)}
          </>
        )
      }
    />
  ) : (
    <p className={s.note}>No score yet for this commit.</p>
  )
}
export function ChangeGlance({ change }: { change: Change }) {
  const roots = new Set([''])
  for (const { path } of change.sizes) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++)
      roots.add(parts.slice(0, i).join('/'))
  }
  // Folder layouts and file diffs are compiled once. Requests only select a
  // stored section; the browser toggles it without React or a round trip.
  return (
    <div data-glance="">
      <div data-change-overview="">
        {[...roots].map((root) => (
          <div key={root} data-glance-root={root} hidden={root !== ''}>
            <Glance
              sizes={change.sizes}
              files={change.files}
              root={cleanRoot(root, change.sizes)}
              what="commit"
              zoomHref={(dir) => `?in=${encodeURIComponent(dir)}`}
              fileHref={(path) =>
                `?in=${encodeURIComponent(root)}&file=${encodeURIComponent(path)}#diffs`
              }
            />
          </div>
        ))}
      </div>
      <div id="diffs">
        {change.files.map((f) => (
          <div key={f.path} data-diff-path={f.path} hidden>
            <FileView
              files={change.files}
              path={f.path}
              backHref="?"
              fileHref={(path) => `?file=${encodeURIComponent(path)}#diffs`}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
export function Commit({
  commit: c,
  change,
}: {
  commit: CommitRecord
  change: Change
  report: Report | null
  before: Report | null
}) {
  const [title, ...rest] = c.message.trim().split('\n'),
    adds = change.files.reduce((n, f) => n + f.additions, 0),
    dels = change.files.reduce((n, f) => n + f.deletions, 0)
  return (
    <div>
      <div className={s.issueHead}>
        <h2 className={s.issueTitle}>{title}</h2>
        {rest.join('\n').trim() && (
          <p className={s.muted} style={{ whiteSpace: 'pre-wrap' }}>
            {rest.join('\n').trim()}
          </p>
        )}
        <div
          style={{
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
            fontSize: 14,
            color: 'var(--ink-dim)',
          }}
        >
          <strong>{c.author_name}</strong>
          <time dateTime={new Date(c.time * 1000).toISOString()}>
            {new Date(c.time * 1000).toISOString().slice(0, 10)}
          </time>
          <span className={s.mono}>{c.hash.slice(0, 7)}</span>
          <span data-live-actions={c.hash} />
          <span>
            <span className={s.add}>+{adds}</span>{' '}
            <span className={s.del}>−{dels}</span> in {change.total} files
          </span>
          {c.parents[0] && (
            <a href={`./${c.parents[0]}`} className={s.mono}>
              parent {c.parents[0].slice(0, 7)}
            </a>
          )}
        </div>
      </div>
      <ChangeGlance change={change} />
      <div data-commit-overview="">
        <div data-live-receipts="" />
        <div dangerouslySetInnerHTML={{ __html: '<!--gild-score-->' }} />
      </div>
    </div>
  )
}
