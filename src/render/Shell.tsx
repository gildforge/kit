import assets from 'gild:asset-manifest'
import tabStyles from 'gild:tab-styles'
import type { HomeData } from '../engine/fragments.js'
import { SiteHeaderView, PortalBarView, SignInView, RepoHeaderView, RepoTabsView, repoTabs, StarView, CloneView } from '../presentation/Headers.js'
import { Sidebar } from './Sidebar.js'
import { RepoIsland } from './RepoIsland.js'
import s from './styles/repo.module.css'
export function RepoHeader({ home: h }: { home: HomeData }) {
  const [owner, repo] = h.repository.split('/'), base = `/${h.repository}`
  return <RepoHeaderView owner={owner} repo={repo} privateRepo={h.acl.visibility === 'private' || !!h.acl.private} archived={h.archived}
    tabs={<RepoTabsView base={base} tabs={repoTabs(h.issues, h.pulls)} here={base} refName={h.ref} />}
    actions={<><StarView count={0} returnTo={base} /><template data-star-template=""><StarView count={0} signedIn busy returnTo={base} /></template><CloneView owner={owner} repo={repo} /></>} />
}
export function HomeFragment({
  home,
  body,
}: {
  home: HomeData
  body: React.ReactNode
}) {
  return (
    <div className={s.page} data-repository={home.repository}>
      <RepoHeader home={home} />
      <div data-page-body="">{body}</div>
    </div>
  )
}
export function Shell({ version }: { version: string }) {
  const theme = `(function(){try{var t=localStorage.getItem('gild.theme')||'dark';document.documentElement.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t==='light'?'light':'dark';}catch(e){document.documentElement.dataset.theme='dark';}})()`
  return (
    <html lang="en" data-repo-router="">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>gild</title>
        <script dangerouslySetInnerHTML={{ __html: theme }} />
        <link rel="stylesheet" href={assets.urls['presentation.css']} />
        {['schibsted-grotesk.woff2', 'jetbrains-mono.woff2'].map(name => <link key={name} rel="preload" as="font" type="font/woff2" crossOrigin="anonymous" href={assets.urls[name]} />)}
        <link rel="icon" href={assets.urls['favicon.svg']} />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <script id="gild-assets" type="application/json" dangerouslySetInnerHTML={{ __html: JSON.stringify(assets.urls).replaceAll('<', '\\u003c') }} />
        <script id="gild-tab-styles" type="application/json" dangerouslySetInnerHTML={{ __html: JSON.stringify(tabStyles) }} />
        <script type="module" src={assets.urls['router.js']} />
        <link rel="modulepreload" href={assets.urls['tab-client.js']} />
      </head>
      <body>
        <SiteHeaderView search={<button className="search-trigger" data-search="" aria-label="Search code"><span>Type / to search</span><kbd>/</kbd></button>} identity={<SignInView />} />
        <main style={{ padding: '0 24px 24px', minWidth: 0 }}>
          <template data-portal-template="">
            <RepoIsland kind="sidebar" props={{ identity: null }}>
              <Sidebar identity={{name:''}} onSignOut={() => {}} />
            </RepoIsland>
            <PortalBarView search={<button className="search-trigger" data-search="" aria-label="Search code"><span>Type / to search</span><kbd>/</kbd></button>} />
          </template>
          <div
            data-fragment-root=""
            dangerouslySetInnerHTML={{ __html: '<!--gild-content-->' }}
          />
        </main>
        <footer
          className="site-footer-grid"
          style={{
            borderTop: '1px solid var(--rule)',
            padding: '22px 16px 34px',
          }}
        >
          <span>
            © <a href="https://samifou.ad">Sami Fouad</a>
          </span>
          <span className="site-footer-credit">
            gild is <a href="https://github.com/gildforge/cli">open source</a>.
            Built on infrastructure from{' '}
            <a href="https://cloudflare.com">Cloudflare</a>.
          </span>
          <span>
            <a href="https://github.com/sponsors/samifouad">donate</a>{' '}
            <button data-theme-toggle="" aria-label="Change theme">
              ☾
            </button>
          </span>
        </footer>
      </body>
    </html>
  )
}
