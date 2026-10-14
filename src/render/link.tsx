import type { AnchorHTMLAttributes } from 'react'
/** Fragments contain ordinary links: no router runtime or data fetching. */
export function FragmentLink({
  scroll: _scroll,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { scroll?: boolean }) {
  return <a {...props} />
}
export default FragmentLink
