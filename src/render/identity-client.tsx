import { createRoot } from 'react-dom/client'
import { Sidebar } from './Sidebar.tsx'
import type { ProfilePicture } from '../engine/types.ts'
export function mountIdentity(
  name: string,
  picture: ProfilePicture | undefined,
  onSignOut: () => Promise<void>,
) {
  if (document.querySelector('[data-identity-rail]')) return
  const rail = document.createElement('div')
  rail.dataset.identityRail = ''
  document.body.prepend(rail)
  createRoot(rail).render(
    <Sidebar identity={{ name, avatar: picture }} onSignOut={onSignOut} />,
  )
  const bar = document.querySelector('.portal-bar')
  if (bar) document.querySelector('.site-header')?.after(bar)
  document.querySelector('.site-header')?.remove()
  document.querySelector('body > footer')?.remove()
  const main = document.querySelector<HTMLElement>(
    '[data-fragment-root]',
  )!.parentElement!
  main.className = 'portal-main'
  main.style.cssText = ''
  if (bar) main.prepend(bar)
}

import { useState } from 'react'
import { StarView } from '../presentation/Headers.tsx'
import type { Root } from 'react-dom/client'
const stars = new WeakMap<HTMLElement, Root>()
export function mountStar(slot: HTMLElement, repository: string, count: number, starred: boolean) {
  let root = stars.get(slot)
  if (!root) { root = createRoot(slot); stars.set(slot, root) }
  root.render(<FragmentStar repository={repository} initialCount={count} initialStarred={starred} />)
}
function FragmentStar({ repository, initialCount, initialStarred }: { repository: string; initialCount: number; initialStarred: boolean }) {
  const [count, setCount] = useState(initialCount), [starred, setStarred] = useState(initialStarred)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <StarView count={count} starred={starred} signedIn returnTo={location.pathname + location.search} busy={busy} error={error} onStar={async () => {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/user/starred/${repository}`, { method: starred ? 'DELETE' : 'PUT' })
      if (!response.ok) throw new Error('Could not update star. Try again.')
      const data = await (await fetch(`/api/repos/${repository}/islands`, { cache: 'no-store' })).json()
      setCount(data.count); setStarred(data.starred)
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }} />
}
