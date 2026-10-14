'use client'
import { publicPageNavigation } from '../engine/public-page-route.js'
import NextLink from 'next/link'
import type { ComponentProps } from 'react'
/** Prefetch belongs to the site-wide intent scheduler, including saveData.
 * App Router's viewport/hover defaults would bypass that policy. */
export default function Link(props: ComponentProps<typeof NextLink>) {
  return <NextLink {...props} prefetch={false} onClick={e => {
    props.onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.currentTarget.target === '_blank') return
    const url = new URL(e.currentTarget.href)
    if (url.origin === location.origin && publicPageNavigation(url)) {
      e.preventDefault()
      location.assign(url.href)
    }
  }} />
}
