'use client'
import { refreshPublicPage, navigatePublicPage } from '../refresh-public.js'

import { useRouter } from 'next/navigation'
import { usePublicViewer } from '../PublicViewer.js'
import { useState, useEffect } from 'react'
import s from '../../render/styles/repo.module.css'
import { post as send } from '../../engine/post.js'

export function NewPullForm({ owner, repo, branches, base: initialBase, head: initialHead, viewerName }: {
  owner: string; repo: string; branches: string[]; base: string; head: string; viewerName?: string
}) {
  const router = useRouter()
  const viewer = usePublicViewer(undefined,{name:viewerName??null})
  const [base, setBase] = useState(initialBase)
  const [head, setHead] = useState(initialHead)
  useEffect(() => {
    const selected=new URLSearchParams(location.search).get('head')
    if(selected && branches.includes(selected))setHead(selected)
  },[branches])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (branches.length < 2) {
    return <p className={s.note}>Push a branch first: a pull request asks to merge one branch into another, and this repo has only {branches[0] ?? 'no branches'}.</p>
  }
  return (
    <form className={s.form} style={{ maxWidth: 820, paddingBlock: 24 }} onSubmit={async (e) => {
      e.preventDefault()
      setBusy(true); setError('')
      try {
        const { number } = await send(`/api/repos/${owner}/${repo}/pulls`, { title, body, head, base })
        navigatePublicPage(router,`/${owner}/${repo}/pulls/${number}`)
      } catch (err) { setError((err as Error).message); setBusy(false) }
    }}>
      <h2 style={{ margin: 0, fontSize: 22 }}>New pull request</h2>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 14 }}>
        <label className={s.control}>merge <select value={head} onChange={(e) => setHead(e.target.value)} aria-label="Branch to merge">{branches.map((b) => <option key={b}>{b}</option>)}</select></label>
        <span>into</span>
        <label className={s.control}><select value={base} onChange={(e) => setBase(e.target.value)} aria-label="Base branch">{branches.map((b) => <option key={b}>{b}</option>)}</select></label>
      </div>
      <label className="sr-only" htmlFor="pr-title">Title</label>
      <input id="pr-title" className={s.input} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
      <label className="sr-only" htmlFor="pr-body">Description</label>
      <textarea id="pr-body" className={s.textarea} placeholder="What does this change, and why? Mention the issue it closes. Markdown works." value={body} onChange={(e) => setBody(e.target.value)} />
      <div className={s.formRow}>
        {error && <span className={s.error}>{error}</span>}
        {!viewer.name && <a className={s.secondary} href={'/auth/device?next='+encodeURIComponent(`/${owner}/${repo}/pulls/new`)} onClick={e=>{e.currentTarget.href='/auth/device?next='+encodeURIComponent(location.pathname+location.search)}}>Sign in to open a pull request</a>}
        <button type="submit" className={s.primary} disabled={busy || !viewer.name || !title.trim() || head === base}>{busy ? 'Opening…' : 'Open pull request'}</button>
      </div>
    </form>
  )
}

export function ReviewForm({ owner, repo, number, canApprove, canRequestChanges }: {
  owner: string; repo: string; number: number; canApprove: boolean; canRequestChanges: boolean
}) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const submit = async (kind: 'comment' | 'approve' | 'changes') => {
    setBusy(kind); setError('')
    try {
      if (kind === 'comment') await send(`/api/repos/${owner}/${repo}/pulls/${number}/comments`, { body })
      else await send(`/api/repos/${owner}/${repo}/pulls/${number}/reviews`, { verdict: kind, body })
      setBody('')
      refreshPublicPage(router)
    } catch (err) { setError((err as Error).message) }
    setBusy(null)
  }
  return (
    <form className={s.form} onSubmit={(e) => { e.preventDefault(); submit('comment') }}>
      <label className="sr-only" htmlFor="review-body">Comment or review</label>
      <textarea id="review-body" className={s.textarea} placeholder="Comment, or say what should change. Markdown works." value={body} onChange={(e) => setBody(e.target.value)} />
      <div className={s.formRow}>
        {error && <span className={s.error}>{error}</span>}
        {canRequestChanges && <button type="button" className={s.secondary} disabled={!!busy || !body.trim()} onClick={() => submit('changes')}>{busy === 'changes' ? '…' : 'Request changes'}</button>}
        {canApprove && <button type="button" className={s.secondary} disabled={!!busy} onClick={() => submit('approve')}>{busy === 'approve' ? '…' : 'Approve'}</button>}
        <button type="submit" className={s.primary} disabled={!!busy || !body.trim()}>{busy === 'comment' ? 'Posting…' : 'Comment'}</button>
      </div>
    </form>
  )
}

export function PullActions({ owner, repo, number, actions }: {
  owner: string; repo: string; number: number
  actions: { action: 'queue' | 'dequeue' | 'close' | 'reopen'; label: string; primary?: boolean }[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  if (!actions.length) return null
  return (
    <div className={s.formRow} style={{ justifyContent: 'flex-start' }}>
      {actions.map((a) => (
        <button key={a.action} type="button" className={a.primary ? s.primary : s.secondary} disabled={!!busy} onClick={async () => {
          setBusy(a.action); setError('')
          try {
            await send(`/api/repos/${owner}/${repo}/pulls/${number}`, { action: a.action })
            refreshPublicPage(router)
          } catch (err) { setError((err as Error).message) }
          setBusy(null)
        }}>{busy === a.action ? (a.action === 'queue' ? 'Queueing…' : '…') : a.label}</button>
      ))}
      {error && <span className={s.error}>{error}</span>}
    </div>
  )
}
