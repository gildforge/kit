import { fileIcon, Folder } from './file-icons.tsx'
import { Picture } from './Picture.tsx'
import type { Entry } from '../engine/types.ts'
import type { HomeData } from '../engine/fragments.ts'
import { HealthBars } from './Health.tsx'
import s from './styles/repo.module.css'

const sort = (entries: Entry[]) =>
  [...entries].sort(
    (a, b) =>
      Number(b.type === 'tree') - Number(a.type === 'tree') ||
      a.name.localeCompare(b.name),
  )
export function Tree({ entries }: { entries: Entry[] }) {
  return (
    <nav className={s.tree} aria-label="Files">
      {sort(entries).map((e) => (
        <div
          key={e.name}
          data-entry={e.name}
          data-kind={e.type}
          data-hash={e.child}
        >
          <a
            href={`?ref=__GILD_REF__&path=__GILD_DIR__${encodeURIComponent(e.name).replaceAll('_', '%5F')}`}
            className={s.row}
            data-context=""
            data-on-class={s.rowOn}
          >
            <span className={s.chev} data-chevron="">
              {e.type === 'tree' ? '▸' : ''}
            </span>
            {e.type === 'tree' ? (
              <Folder />
            ) : (
              <span className={s.icon} style={{ color: fileIcon(e.name)[1] }}>
                {fileIcon(e.name)[0]}
              </span>
            )}
            <span className={s.label}>{e.name}</span>
          </a>
          <div data-children="" hidden />
        </div>
      ))}
    </nav>
  )
}
export function BlobView({ html, note }: { html?: string; note?: string }) {
  return note ? (
    <div className={s.note}>
      {note}{' '}
      <a
        href="?ref=__GILD_REF__&amp;path=__GILD_PATH__&amp;raw=1"
        data-raw=""
        download="__GILD_DOWNLOAD__"
        data-context=""
      >
        View raw
      </a>
    </div>
  ) : (
    <div className={s.code} dangerouslySetInnerHTML={{ __html: html ?? '' }} />
  )
}
export function Home({ home: h }: { home: HomeData }) {
  if (!h.commit)
    return (
      <div className={s.body}>
        <main className={s.main}>
          <section className={s.panel}>
            <div className={s.note}>
              <h2>This repository is empty.</h2>
              <p>Push your first commit to get started.</p>
              <pre>{`gild repo clone ${h.repository}\ncd ${h.repository.split('/')[1]}\ngit add . && git commit -m "first commit" && git push`}</pre>
            </div>
          </section>
        </main>
      </div>
    )
  const base = `/${h.repository}`,
    q = `?ref=${encodeURIComponent(h.ref)}`
  return (
    <div className={s.body}>
      <div className={s.side}>
        <form action={base} className={s.control}>
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="6" cy="6" r="2.5" />
            <circle cx="6" cy="18" r="2.5" />
            <circle cx="18" cy="8" r="2.5" />
            <path d="M6 8.5v7M18 10.5c0 4-6 3-11 6" />
          </svg>
          <label htmlFor="gild-ref" className="sr-only">
            Branch or tag
          </label>
          <select id="gild-ref" name="ref" defaultValue={h.ref} data-branch="">
            {[...h.branches, ...h.tags].map((ref) => (
              <option key={ref}>{ref}</option>
            ))}
          </select>
          <noscript>
            <button>Go</button>
          </noscript>
        </form>
        <div data-tree-root="">
          <Tree entries={h.tree} />
        </div>
      </div>
      <main className={s.main}>
        <div className={s.commitBar}>
          <span className={s.author}>{h.commit.author_name || 'unknown'}</span>
          <span className={s.message}>{h.commit.message.split('\n')[0]}</span>
          <a href={`${base}/commit/${h.commit.hash}`} className={s.sha}>
            {h.commit.hash.slice(0, 7)} ·{' '}
            <time dateTime={new Date(h.commit.time * 1000).toISOString()}>
              {new Date(h.commit.time * 1000).toISOString().slice(0, 10)}
            </time>
          </a>
        </div>
        <section className={s.panel}>
          <div className={s.panelHead}>
            <span data-file-name="">README</span>
          </div>
          <div
            data-file-pane=""
            dangerouslySetInnerHTML={{ __html: '<!--gild-file-->' }}
          />
        </section>
      </main>
      <aside className={s.about} aria-label="About">
        <div className={s.section}>
          <h2>About</h2>
          <p className={s.desc}>{h.description || 'No description yet.'}</p>
        </div>
        {h.tags.length > 0 && (
          <div className={s.section}>
            <h2>
              Releases <span className={s.count}>{h.tags.length}</span>
            </h2>
            <span>{h.tags[0]}</span>
          </div>
        )}
        {h.contributors.length > 0 && (
          <div className={s.section}>
            <h2>
              Contributors{' '}
              <span className={s.count}>{h.contributors.length}</span>
            </h2>
            {h.contributors.slice(0, 8).map((p) => (
              <div key={p.name} className={s.person}>
                <Picture name={p.name} picture={p.picture} size={24} />
                {p.name}
              </div>
            ))}
          </div>
        )}
        {h.languages.length > 0 && (
          <div className={s.section}>
            <h2>Languages</h2>
            <div className={s.langBar}>
              {h.languages.map((l) => (
                <span
                  key={l.name}
                  style={{ width: `${l.share * 100}%`, background: l.color }}
                />
              ))}
            </div>
            <div className={s.langs}>
              {h.languages.slice(0, 6).map((l) => (
                <span key={l.name} className={s.lang}>
                  <span className={s.dot} style={{ background: l.color }} />
                  <strong>{l.name}</strong>
                  <span className={s.muted}>{(l.share * 100).toFixed(1)}%</span>
                </span>
              ))}
            </div>
          </div>
        )}
        <div className={s.section}>
          <HealthBars
            report={h.score}
            href={`${base}/score${q}`}
            note={`${h.ref} at ${h.commit.hash.slice(0, 7)}`}
          />
        </div>
        <div className={s.section}>
          <p className={s.muted}>
            {h.commits >= 100 ? '100+' : h.commits} commits on {h.ref}
          </p>
        </div>
      </aside>
    </div>
  )
}
