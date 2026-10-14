import s from './styles/repo.module.css'
import a from './styles/actions.module.css'
import c from './styles/Channel.module.css'
import h from './styles/health.module.css'
/** Reuse the real page's boxes and responsive CSS. No animation affects layout. */
const bar = <span className="tab-skeleton-line" />
export function TabSkeleton({ tab }: { tab: string }) {
  if (tab === 'agents')
    return (
      <section className={c.channel}>
        <div className={c.main}>
          <div className={c.bar}>{bar}</div>
          <div className={c.log}>
            {bar}
            {bar}
          </div>
          <div className={c.input}>{bar}</div>
        </div>
        <aside className={c.participants}>{bar}</aside>
      </section>
    )
  if (tab === 'actions')
    return (
      <div className={a.board}>
        <nav className={a.workflows}>
          {bar}
          {bar}
        </nav>
        <div className={a.main}>
          <div className={a.heading}>{bar}</div>
          {bar}
          {bar}
          <section className={a.panel}>
            {bar}
            {bar}
          </section>
        </div>
      </div>
    )
  if (tab === 'score')
    return (
      <section className={h.review}>
        <div className={h.head}>
          {bar}
          {bar}
        </div>
        <div className={h.dials}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className={h.dial}>
              <svg viewBox="0 0 62 62" width="62" height="62" aria-hidden>
                <circle
                  cx="31"
                  cy="31"
                  r="26"
                  fill="none"
                  stroke="var(--rule)"
                  strokeWidth="4"
                />
              </svg>
              <span className={h.dialTitle}>{bar}</span>
              <span className={h.delta}>{bar}</span>
            </div>
          ))}
        </div>
        <div className={h.panels}>
          <div className={h.findings}>
            <div className={h.panelHead}>{bar}</div>
            <div className={h.rule}>
              {bar}
              {bar}
            </div>
          </div>
          <aside className={h.calibration}>
            <div className={h.panelHead}>{bar}</div>
            <p>
              {bar}
              {bar}
            </p>
          </aside>
        </div>
      </section>
    )
  if (tab === 'issues' || tab === 'pulls') {
    const list = (
      <div className={s.main}>
        <div className={s.listBar}>
          {bar}
          {bar}
          {bar}
        </div>
        <div className={s.list}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={s.item}>
              <div className={s.itemMain}>
                {bar}
                {bar}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
    return tab === 'pulls' ? (
      <div className={s.body} style={{ paddingTop: 0 }}>
        {list}
        <aside className={s.queue} style={{ marginTop: 20 }}>
          {bar}
          {bar}
        </aside>
      </div>
    ) : (
      <>
        {list}
        <p className={s.hint}>{bar}</p>
      </>
    )
  }
  return (
    <div className={s.body}>
      <aside className={s.side}>
        <div className={s.control}>{bar}</div>
        <div className={s.tree}>
          {bar}
          {bar}
          {bar}
        </div>
      </aside>
      <div className={s.main}>
        <div className={s.commitBar}>{bar}</div>
        <div className={s.panel}>
          <div className={s.panelHead}>{bar}</div>
          <div className={s.readme}>
            {bar}
            {bar}
            {bar}
          </div>
        </div>
      </div>
      <aside className={s.about}>
        {bar}
        {bar}
      </aside>
    </div>
  )
}
