'use client'
import { Suspense } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import Link from './Link.js'
import { SignInView } from '../presentation/Headers.js'
function WithQuery({ path }: { path: string }) {
  const query = useSearchParams().toString()
  return <SignInView Link={Link} returnTo={path + (query ? '?' + query : '')} />
}
export function SiteSignIn() {
  const path = usePathname()
  // useSearchParams() bails a statically built page out to client rendering
  // up to the nearest boundary. Without this one, the site 404 (/_not-found)
  // was built as an empty body (gild-site#64). Dynamic pages resolve inline.
  return <Suspense fallback={<SignInView Link={Link} returnTo={path} />}><WithQuery path={path} /></Suspense>
}
