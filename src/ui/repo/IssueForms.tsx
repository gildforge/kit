'use client'
import { refreshPublicPage, navigatePublicPage } from '../refresh-public.js'

import { useRouter } from 'next/navigation'
import { usePublicViewer } from '../PublicViewer.js'
import { useState } from 'react'
import s from '../../render/styles/repo.module.css'
import { post as send } from '../../engine/post.js'

export function NewIssueForm({ owner, repo, viewerName }: { owner: string; repo: string; viewerName?: string }) {
  const router = useRouter()
  const viewer = usePublicViewer(undefined,{name:viewerName??null})
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <form className={s.form} style={{ maxWidth: 820, paddingBlock: 24 }} onSubmit={async (e) => {
      e.preventDefault()
      setBusy(true); setError('')
      try {
        const { number } = await send(`/api/repos/${owner}/${repo}/issues`, { title, body })
        navigatePublicPage(router,`/${owner}/${repo}/issues/${number}`)
      } catch (err) { setError((err as Error).message); setBusy(false) }
    }}>
      <h2 style={{ margin: 0, fontSize: 22 }}>New issue</h2>
      <label className="sr-only" htmlFor="issue-title">Title</label>
      <input id="issue-title" className={s.input} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus />
      <label className="sr-only" htmlFor="issue-body">Description</label>
      <textarea id="issue-body" className={s.textarea} placeholder="What should change, and why? Markdown works." value={body} onChange={(e) => setBody(e.target.value)} />
      <div className={s.formRow}>
        {error && <span className={s.error}>{error}</span>}
        {!viewer.name && <a className={s.secondary} href={'/auth/device?next='+encodeURIComponent(`/${owner}/${repo}/issues/new`)}>Sign in to open an issue</a>}
        <button type="submit" className={s.primary} disabled={busy || !viewer.name || !title.trim()}>{busy ? 'Opening…' : 'Open issue'}</button>
      </div>
    </form>
  )
}

export function CommentForm({ owner, repo, number }: { owner: string; repo: string; number: number }) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <form className={s.form} onSubmit={async (e) => {
      e.preventDefault()
      setBusy(true); setError('')
      try {
        await send(`/api/repos/${owner}/${repo}/issues/${number}/comments`, { body })
        setBody('')
        refreshPublicPage(router)
      } catch (err) { setError((err as Error).message) }
      setBusy(false)
    }}>
      <label className="sr-only" htmlFor="comment-body">Comment</label>
      <textarea id="comment-body" className={s.textarea} placeholder="Leave a comment. Markdown works." value={body} onChange={(e) => setBody(e.target.value)} />
      <div className={s.formRow}>
        {error && <span className={s.error}>{error}</span>}
        <button type="submit" className={s.primary} disabled={busy || !body.trim()}>{busy ? 'Posting…' : 'Comment'}</button>
      </div>
    </form>
  )
}

export function IssueActions({ owner, repo, number, actions }: {
  owner: string; repo: string; number: number
  actions: { action: 'close' | 'reopen' | 'claim' | 'unclaim'; label: string }[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  if (actions.length === 0) return null
  return (
    <div className={s.formRow} style={{ justifyContent: 'flex-start' }}>
      {actions.map((a) => (
        <button key={a.action} type="button" className={s.secondary} disabled={!!busy} onClick={async () => {
          setBusy(a.action); setError('')
          try {
            await send(`/api/repos/${owner}/${repo}/issues/${number}`, { action: a.action })
            refreshPublicPage(router)
          } catch (err) { setError((err as Error).message) }
          setBusy(null)
        }}>{busy === a.action ? '…' : a.label}</button>
      ))}
      {error && <span className={s.error}>{error}</span>}
    </div>
  )
}
