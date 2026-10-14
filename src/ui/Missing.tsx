import Link from './Link.js'

/** The 404 message: a missing user, org, repository or page. */
export function Missing() {
  return (
    <div style={{ padding: '72px 0', maxWidth: 560 }}>
      <p className="mono-dim" style={{ margin: 0 }}>404</p>
      <h1 style={{ fontSize: 26, margin: '6px 0 10px' }}>Nothing lives here</h1>
      <p style={{ color: 'var(--ink-soft)', fontSize: 15, margin: '0 0 18px' }}>
        No user, org or repository by that name. It may have been renamed, or the link has a typo.
      </p>
      <Link href="/" style={{ color: 'var(--accent)' }}>Back to gild</Link>
    </div>
  )
}
