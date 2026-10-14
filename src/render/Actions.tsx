'use client'
import { useEffect, useState } from 'react'
import { FragmentLink as Link } from './link.js'
import type { Status } from '../engine/types.js'
import s from './styles/actions.module.css'
const live = (status: Status) => ['queued', 'running'].includes(status)
export function ActionMark({ status }: { status: Status }) {
  return (
    <span
      className={`${s.status} ${s[status] ?? ''}`}
      aria-label={status}
      title={status}
    >
      {status === 'success'
        ? '✓'
        : ['failure', 'cancelled'].includes(status)
          ? '×'
          : status === 'skipped'
            ? '–'
            : '•'}
    </span>
  )
}
export function CommitActions({
  runs: initial,
  owner,
  repo,
  sha,
}: {
  runs: { id: number; status: Status; workflow: { file: string } }[]
  owner: string
  repo: string
  sha: string
}) {
  const [runs, setRuns] = useState(initial)
  const active = runs.some((r) => live(r.status))
  useEffect(() => {
    if (!active) return
    let dead = false
    const t = setInterval(async () => {
      try {
        const next = await fetch(
          `/api/repos/${owner}/${repo}/actions/commits/${sha}`,
          { cache: 'no-store' },
        ).then(async (r) => {
          if (!r.ok) throw new Error('Actions unavailable')
          return r.json()
        })
        if (!dead) setRuns(next)
      } catch {}
    }, 3000)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [owner, repo, sha, active])
  return (
    <span className={s.form}>
      {runs.map((r) => (
        <Link
          key={r.id}
          href={`/${owner}/${repo}/actions/${r.id}`}
          className={s.meta}
        >
          <ActionMark status={r.status} /> {r.workflow.file}
        </Link>
      ))}
    </span>
  )
}
