import type { FileDiff } from '../engine/types.ts'
import s from './styles/repo.module.css'

/** The anchor a file's diff sits at, so Glance can link straight to it. */
export const fileAnchor = (path: string) =>
  `f-${path.replace(/[^A-Za-z0-9._-]/g, '-')}`

export function Diff({ file }: { file: FileDiff }) {
  return (
    <section className={s.diffFile} id={fileAnchor(file.path)}>
      <div className={s.diffHead}>
        <span>
          {file.path} <span className={s.muted}>· {file.status}</span>
        </span>
        <span>
          <span className={s.add}>+{file.additions}</span>{' '}
          <span className={s.del}>−{file.deletions}</span>
        </span>
      </div>
      {file.note ? (
        <div className={s.note}>{file.note}</div>
      ) : (
        <div className={s.diff}>
          {file.hunks.map((h, hi) => {
            let a = h.oldStart
            let b = h.newStart
            return (
              <div key={hi}>
                <div className={s.dHunk}>
                  @@ −{h.oldStart} +{h.newStart} @@
                </div>
                {h.lines.map((line, li) => {
                  const kind = line[0]
                  const left = kind === '+' ? '' : a++
                  const right = kind === '-' ? '' : b++
                  return (
                    <div
                      key={li}
                      className={`${s.dl} ${kind === '+' ? s.dAdd : kind === '-' ? s.dDel : ''}`}
                    >
                      <span className={s.dn}>{left}</span>
                      <span className={s.dn}>{right}</span>
                      <span className={s.dt}>{line || ' '}</span>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/** One file's diff on its own, reached from a Glance tile: back to the map,
 *  and steps through the other changed files in the order Glance ranks them. */
export function FileView({
  files,
  path,
  backHref,
  fileHref,
}: {
  files: FileDiff[]
  path: string
  backHref: string
  fileHref: (path: string) => string
}) {
  const ranked = [...files].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  )
  const i = ranked.findIndex((f) => f.path === path)
  if (i < 0)
    return (
      <p className={s.note}>
        That file isn&apos;t part of this change.{' '}
        <a href={backHref} style={{ color: 'var(--accent)' }}>
          Back to Glance
        </a>
      </p>
    )
  const prev = ranked[i - 1]
  const next = ranked[i + 1]
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        paddingBlock: 20,
      }}
    >
      <nav
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px 18px',
          alignItems: 'center',
          fontSize: 14,
        }}
        aria-label="Files in this change"
      >
        <a href={backHref} style={{ color: 'var(--accent)' }}>
          ← Glance
        </a>
        <span className={s.muted}>
          file {i + 1} of {ranked.length}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 16 }}>
          {prev ? (
            <a href={fileHref(prev.path)} className={s.mono} title={prev.path}>
              ← {prev.path.split('/').pop()}
            </a>
          ) : null}
          {next ? (
            <a href={fileHref(next.path)} className={s.mono} title={next.path}>
              {next.path.split('/').pop()} →
            </a>
          ) : null}
        </span>
      </nav>
      <Diff file={ranked[i]} />
    </div>
  )
}
