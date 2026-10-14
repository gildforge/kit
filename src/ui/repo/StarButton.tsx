'use client'
import { refreshPublicPage, navigatePublicPage } from '../refresh-public.js'
import { usePublicViewer } from '../PublicViewer.js'
import { useState, useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import Link from '../Link.js'
import { StarView } from '../../presentation/Headers.js'

export function StarButton({
  owner,
  repo,
  count,
  starred,
  signedIn,
}: {
  owner: string
  repo: string
  count: number
  starred: boolean
  signedIn: boolean
}) {
  const viewer = usePublicViewer(`${owner}/${repo}`, {name:signedIn?'viewer':null,count,starred})
  signedIn = !!viewer.name
  count = viewer.count ?? count
  starred = viewer.starred ?? starred
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [refreshing, startTransition] = useTransition()
  const router = useRouter()
  const pathname = usePathname(),
    search = useSearchParams().toString()
  const returnTo = pathname + (search ? '?' + search : '')
  return <StarView Link={Link} count={count} starred={starred} signedIn={signedIn} returnTo={returnTo} busy={busy || refreshing} error={error}
    onStar={async () => {
      setBusy(true)
      setError('')
      try {
        const response = await fetch(
          `/api/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
          { method: starred ? 'DELETE' : 'PUT' },
        )
        if (!response.ok)
          throw new Error('Could not update star. Try again.')
        startTransition(() => router.refresh())
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    }} />
}
