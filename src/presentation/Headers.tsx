import type { AnchorHTMLAttributes, ComponentType, ReactNode } from 'react'
import s from '../render/styles/repo.module.css'

type LinkView = ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>
const Anchor: LinkView = (props) => <a {...props} />

/** Pure chrome shared by Next and the independently cached fragment renderer. */
export function SiteHeaderView({ search, identity, Link = Anchor }: {
  search: ReactNode; identity: ReactNode; Link?: LinkView
}) {
  return <header className="site-header">
    <Link href="/" className="site-logo" aria-label="gild"><img className="site-mark" src="/logo.svg" alt="" width={26} height={26} /></Link>
    <PortalBarView search={search} />
    <nav className="site-nav" aria-label="Site">
      <Link href="/download">Download</Link>
      <span data-identity="">{identity}</span>
    </nav>
  </header>
}

/** The footer every gild page shares: credit, the logo and wordmark, then links. `theme` is the page's theme control. */
export function FooterView({ theme, Link = Anchor }: { theme: ReactNode; Link?: LinkView }) {
  return <footer style={{ borderTop: '1px solid var(--rule)', padding: '22px 16px 34px' }}>
    <div className="site-footer-grid">
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, justifySelf: 'start' }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a 32px static avatar */}
        <img src="/addis-circle.svg" alt="" width={32} height={32} style={{ borderRadius: '50%' }} />
        <span>© {new Date().getUTCFullYear()} <a href="https://addis.gg" style={{ color: 'var(--ink)' }}>Addis Corp</a></span>
      </span>
      <Link href="/" className="site-logo" aria-label="gild home" style={{ justifySelf: 'center', color: 'var(--ink)' }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static SVG mark */}
        <img className="site-mark" src="/logo.svg" alt="" width={26} height={26} />gild
      </Link>
      <span style={{ display: 'flex', alignItems: 'center', gap: 14, justifySelf: 'end' }}>
        <Link href="/download">download</Link>
        <a href="https://github.com/orgs/gildforge/repositories">github</a>
        <a href="/brand">brand</a>
        <a href="https://github.com/sponsors/samifouad">tip jar</a>
        {theme}
      </span>
    </div>
  </footer>
}

/** What the search button shows: the prompt and its key on wide screens, a magnifying glass on a phone (CSS picks). */
export function SearchTriggerContent() {
  return <>
    <svg className="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
    <span>Type / to search</span><kbd>/</kbd>
  </>
}

export function IdentityView({ name, picture, Link = Anchor }: { name: string; picture?: ReactNode; Link?: LinkView }) {
  return <Link href="/dashboard" className="site-identity">{picture}<span className="identity-label" title={`@${name}`}>@{name}</span></Link>
}

export function SignInView({ returnTo = '/', Link = Anchor }: { returnTo?: string; Link?: LinkView }) {
  return <Link href={`/auth/device?next=${encodeURIComponent(returnTo)}`} className="site-signin" data-return-to="">Sign in</Link>
}

export function repoTabs(issues: number, pulls: number) {
  return [
    { label: 'Code', path: '' },
    { label: 'Issues', path: '/issues', count: issues },
    { label: 'Pull requests', path: '/pulls', count: pulls },
    { label: 'Actions', path: '/actions' },
    { label: 'Agents', path: '/agents' },
    { label: 'Score', path: '/score' },
    { label: 'Settings', path: '/settings/general' },
  ]
}
/** Tabs only a repository's contributors see (and may open). */
export const CONTRIBUTOR_TABS = ['actions', 'agents', 'score']
export function RepoTabsView({ base, tabs, here, refName, write = false, contributor = false, Link = Anchor }: {
  base: string; tabs: { label: string; path: string; count?: number }[]
  here: string; refName?: string; write?: boolean; contributor?: boolean; Link?: LinkView
}) {
  return <nav aria-label="Repository" className={s.tabs}>
    {tabs.map((t) => {
      const href = base + t.path, key = t.path.split('/')[1] || 'code'
      const on = t.path === '' ? here === base : here.startsWith(base + '/' + key)
      return <Link key={t.label} href={href + (refName && ['', '/score'].includes(t.path) ? `?ref=${encodeURIComponent(refName)}` : '')}
        className={s.tab} aria-current={on ? 'page' : undefined} data-tab={key}
        data-settings={key === 'settings' ? '' : undefined} data-contributor={CONTRIBUTOR_TABS.includes(key) ? '' : undefined}
        hidden={(key === 'settings' && !write) || (CONTRIBUTOR_TABS.includes(key) && !contributor && !write)}>
        {t.label}{t.count !== undefined && <span className={s.count}>{t.count}</span>}
      </Link>
    })}
  </nav>
}
export function RepoHeaderView({ owner, repo, privateRepo, archived, tabs, actions, Link = Anchor }: {
  owner: string; repo: string; privateRepo: boolean; archived: boolean
  tabs: ReactNode; actions: ReactNode; Link?: LinkView
}) {
  return <header className={s.head} data-repo-header="">
    <div className={s.titleRow}><h1 className={s.title}>
      <Link href={`/${owner}`} className={s.owner}>{owner}</Link>
      <span className={s.slash}>/</span><Link href={`/${owner}/${repo}`} className={s.name}>{repo}</Link>
      <span className={s.badge}>{privateRepo ? 'private' : 'public'}</span>
      {archived && <span className={s.badge}>archived</span>}
    </h1></div>
    <div className={s.tabRow}>{tabs}<div className={s.repoActions} data-repo-actions="">{actions}</div></div>
  </header>
}

export function StarView({ count, starred = false, signedIn = false, returnTo, busy = false, error = '', onStar, Link = Anchor }: {
  count: number; starred?: boolean; signedIn?: boolean; returnTo: string
  busy?: boolean; error?: string; onStar?: () => void; Link?: LinkView
}) {
  return <div className={s.star} data-star-slot="" data-anonymous-star={signedIn ? undefined : ''}>
    {signedIn ? <button className={s.control} type="button" data-star="" aria-pressed={starred} disabled={busy} onClick={onStar}>
      <span data-star-label="">{starred ? '★ Unstar' : '☆ Star'}</span> <span data-star-count="" title={`${count} stars`}>{count}</span>
    </button> : <><span className={s.starCount} data-star-count="" aria-label={`${count} stars`} title={`${count} stars`}>☆ {count}</span>
      <Link className={s.control} data-return-to="" href={`/auth/device?next=${encodeURIComponent(returnTo)}`}>Sign in to star</Link></>}
    {error && <span role="alert" className={s.starError}>{error}</span>}
  </div>
}
export function CloneView({ owner, repo }: { owner: string; repo: string }) {
  return <details className={s.clone} data-clone="">
    <summary className={s.primary}>Clone</summary>
    <div className={s.clonePanel}>
      <span className={s.muted}>With the gild CLI (push credentials wired in)</span>
      <CloneLine text={`gild repo clone ${owner}/${repo}`} />
      <span className={s.muted}>With plain git</span>
      <CloneLine text={`git clone https://gild.gg/${owner}/${repo}.git`} />
    </div>
  </details>
}
function CloneLine({ text }: { text: string }) {
  return <div className={s.cloneLine}><code>{text}</code><button type="button" className={s.small} data-copy={text}>copy</button></div>
}

export function PortalBarView({ search }: { search: ReactNode }) {
  return <div className="portal-bar">{search}</div>
}
