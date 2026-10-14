'use client'

import { FragmentLink as Link } from './link.tsx'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SIDEBAR_BOOTSTRAP, initialSidebarIntent, consumeSidebarIntent } from '../presentation/sidebar-bootstrap.ts'

import { Picture } from './Picture.tsx'
import type { ProfilePicture } from '../engine/types.ts'

// Rail metrics lifted from the zega dashboard (lib/html.ts + dashboard.css):
// fixed 22px icon wells, labels hidden (not moved) when collapsed, so the
// icon column never shifts. 196px open / 68px rail.
const feather = (body: string, size = 18) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    dangerouslySetInnerHTML={{ __html: body }}
  />
)

const FEATURES = [
  { href:'/import',label:'import repo',icon:feather('<path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"/>') },
  {
    href: '/new',
    label: 'new repo',
    icon: feather('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  },
  {
    href: '/dashboard',
    label: 'your repos',
    icon: feather(
      '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
    ),
  },
  {
    href: '/agents',
    label: 'agents',
    icon: feather(
      '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 16 0v1"/>',
    ),
  },
  {
    href: '/settings/runners',
    label: 'runners',
    icon: feather(
      '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    ),
  },
]

const ACCOUNT = [
  {
    href: '/settings/keys',
    label: 'keys & devices',
    icon: feather(
      '<path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    ),
  },
  {
    href: '/settings/profile',
    label: 'settings',
    icon: feather(
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    ),
  },
]

export function Sidebar({
  identity,
  onSignOut,
}: {
  onSignOut: () => Promise<void> | void
  identity?: { name: string; avatar?: ProfilePicture } | null
}) {
  // The rail sits on top of the page, so it starts collapsed: opened, it
  // covers content until it is closed again.
  const earlyIntent = useRef(initialSidebarIntent())
  const [open, setOpen] = useState(earlyIntent.current ?? false)

  useEffect(() => {
    if (earlyIntent.current === undefined) setOpen(localStorage.getItem('gild.sidebar') === 'expanded')
  }, [])
  const set = (next: boolean) => {
    setOpen(next)
    localStorage.setItem('gild.sidebar', next ? 'expanded' : 'collapsed')
  }
  const toggle = () => set(!open)
  // The open menu covers the page, so following a link from it closes it.
  const close = () => {
    if (open) set(false)
  }
  // …and so does a click or tap anywhere outside it, or Escape.
  const rail = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const element = rail.current
    // A genuine click may arrive after render captured its initial state but
    // before this commit. Consume the latest intent before yielding handlers;
    // a layout update commits it before paint or the next browser event.
    const latestIntent = consumeSidebarIntent()
    if (latestIntent !== undefined) {
      earlyIntent.current = latestIntent
      setOpen(latestIntent)
    }
    element?.setAttribute('data-sidebar-client-ready', '')
    return () => element?.removeAttribute('data-sidebar-client-ready')
  }, [])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (rail.current && !rail.current.contains(e.target as Node)
        && !(e.target instanceof Element && e.target.closest('.portal-menu'))) set(false)
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') set(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const row = (entry: {
    href: string
    label: string
    icon: React.ReactNode
  }) => (
    <Link
      key={entry.href}
      href={entry.href}
      data-tip={entry.label}
      className="sidebar-row"
      onClick={close}
    >
      <span className="sidebar-well">{entry.icon}</span>
      <span className="sidebar-label">{open ? entry.label : ''}</span>
    </Link>
  )

  const signOut = async () => {
    close()
    await onSignOut()
  }

  return (
    <>
      <script data-sidebar-bootstrap="" dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOTSTRAP }} />
      <button
        className="portal-menu"
        aria-label="Menu"
        aria-expanded={open}
        onClick={toggle}
      >
        ☰
      </button>
      <aside
        ref={rail}
        data-sidebar-intent={earlyIntent.current === undefined ? undefined : open ? 'expanded' : 'collapsed'}
        className={`sidebar${open ? '' : ' sidebar-collapsed'}`}
      >
        <nav className="sidebar-rows" aria-label="Portal">
          {FEATURES.map(row)}
        </nav>

        {/* the dead middle: click to collapse/expand */}
        <button
          className="sidebar-mid"
          onClick={toggle}
          aria-label={open ? 'collapse menu' : 'expand menu'}
          tabIndex={-1}
        />

        <div className="sidebar-bottom">
          <div className="sidebar-rule" aria-hidden="true" />

          {identity && (
            <Link
              href="/settings"
              className="sidebar-row sidebar-identity"
              data-tip={`@${identity.name}`}
              onClick={close}
            >
              <span className="sidebar-well">
                <Picture
                  picture={identity.avatar}
                  name={identity.name}
                  size={22}
                />
              </span>
              <span className="sidebar-label">
                {open ? `@${identity.name}` : ''}
              </span>
            </Link>
          )}

          <nav
            className="sidebar-rows sidebar-account-rows"
            aria-label="Account"
          >
            {ACCOUNT.map(row)}
            <button
              className="sidebar-row sidebar-signout"
              onClick={signOut}
              data-tip="sign out"
            >
              <span className="sidebar-well">
                {feather(
                  '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
                )}
              </span>
              <span className="sidebar-label">{open ? 'sign out' : ''}</span>
            </button>
          </nav>

          <div className="sidebar-rule" aria-hidden="true" />
          <button
            className="sidebar-collapse"
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={open ? 'Collapse' : 'Expand'}
            data-tip={open ? 'Collapse' : 'Expand'}
          >
            <span className="sidebar-glyph" aria-hidden="true" />
          </button>
        </div>
      </aside>
    </>
  )
}
