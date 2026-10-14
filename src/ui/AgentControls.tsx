'use client'
import { refreshPublicPage, navigatePublicPage } from './refresh-public.js'

import { displayIdentity } from '../engine/channel/identity.js'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`)
  return data
}

const field = { background: 'var(--bg)', color: 'var(--ink)', border: '1px solid var(--rule)', borderRadius: 8, padding: '9px 12px', font: 'inherit', fontSize: 14 } as const
const primary = { background: 'var(--accent)', color: 'var(--accent-ink)', border: 0, borderRadius: 8, padding: '9px 14px', font: 'inherit', fontWeight: 700, fontSize: 14, cursor: 'pointer' } as const
const secondary = { background: 'transparent', color: 'var(--ink)', border: '1px solid var(--rule)', borderRadius: 8, padding: '7px 12px', font: 'inherit', fontSize: 13, cursor: 'pointer' } as const

const WHAT: Record<string, string> = { pr: 'push branches, claim issues', review: 'approve, request changes', queue: 'run the merge queue' }

/** One join request: who is asking, for what, with Approve and Deny. */
export function RequestCard({ request, canGrant }: {
  request: { id: string; sponsor: string; label: string; key: string; repo: string | null; grants: string[]; note: string | null; createdAt: string; age: string }
  /** Whether the viewer can grant access in the requested repo. */
  canGrant: boolean
}) {
  const router = useRouter()
  const [grants, setGrants] = useState<string[]>(canGrant ? request.grants : [])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(decision); setError('')
    try {
      await call(`/api/agents/requests/${request.id}`, 'POST', { decision, grants })
      setDone(decision === 'approve' ? 'Approved. The agent picks up its token on its next check.' : 'Denied.')
      refreshPublicPage(router)
    } catch (err) { setError((err as Error).message) }
    setBusy(null)
  }
  return (
    <div style={{ display: 'grid', gap: 10, border: '1px solid var(--accent)', borderRadius: 12, padding: 16, background: 'var(--surface)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong style={{ fontFamily: 'var(--font-mono)', fontSize: 15 }}>@{displayIdentity(`${request.sponsor}/${request.label}`)} <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 400, color: 'var(--ink-dim)' }}>wants to join</span></strong>
        <span style={{ fontSize: 13, color: 'var(--ink-faint)', fontFamily: 'var(--font-mono)' }}>key {request.key} · {request.age}</span>
      </div>
      {request.note && <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-soft)' }}>&ldquo;{request.note}&rdquo;</p>}
      {request.repo && (
        <div style={{ display: 'grid', gap: 6, fontSize: 14 }}>
          <span>In <span style={{ fontFamily: 'var(--font-mono)' }}>{request.repo}</span>{canGrant ? ', allow it to:' : ' (you can\'t grant access there, so it joins with none):'}</span>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {['pr', 'review', 'merge', 'coordinate'].map((g) => (
              <label key={g} style={{ display: 'flex', gap: 6, alignItems: 'center', color: canGrant ? 'var(--ink)' : 'var(--ink-faint)' }}>
                <input type="checkbox" disabled={!canGrant || !!done} checked={grants.includes(g)} onChange={() => setGrants(grants.includes(g) ? grants.filter((x) => x !== g) : [...grants, g])} />
                {g} <span style={{ color: 'var(--ink-faint)', fontSize: 12 }}>{WHAT[g]}{request.grants.includes(g) ? ' · asked' : ''}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {done ? <span style={{ fontSize: 14, color: 'var(--ok)' }}>{done}</span> : (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={primary} disabled={!!busy} onClick={() => decide('approve')}>{busy === 'approve' ? 'Approving…' : 'Approve'}</button>
          <button type="button" style={secondary} disabled={!!busy} onClick={() => decide('deny')}>{busy === 'deny' ? '…' : 'Deny'}</button>
          {error && <span style={{ color: 'var(--bad)', fontSize: 13 }}>{error}</span>}
        </div>
      )}
    </div>
  )
}

export function AgentActions({ label, name, approver }: { label: string; name: string; approver: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  return (
    <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }} title="It can approve new agents for you, never beyond what it holds itself">
          <input type="checkbox" checked={approver} disabled={busy} onChange={async (e) => {
            setBusy(true); setError('')
            try { await call(`/api/agents/${label}`, 'POST', { action: 'approver', value: e.target.checked }); refreshPublicPage(router) } catch (err) { setError((err as Error).message) }
            setBusy(false)
          }} />
          approves new agents for you
        </label>
        {confirming ? (
          <>
            <button type="button" style={{ ...secondary, color: 'var(--bad)', borderColor: 'var(--bad)' }} disabled={busy} onClick={async () => {
              setBusy(true)
              try { await call(`/api/agents/${label}`, 'DELETE'); refreshPublicPage(router) } catch (err) { setError((err as Error).message) }
              setBusy(false); setConfirming(false)
            }}>Revoke @{displayIdentity(name)}</button>
            <button type="button" style={secondary} onClick={() => setConfirming(false)}>Keep</button>
          </>
        ) : <button type="button" style={secondary} onClick={() => setConfirming(true)}>Revoke</button>}
      </div>
      {error && <span style={{ color: 'var(--bad)', fontSize: 13 }}>{error}</span>}
    </div>
  )
}

export function GrantForm({ owner, repo, agents, initial }: {
  owner: string; repo: string; agents: string[]; initial?: { agent: string; grants: string[] }
}) {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const [agent, setAgent] = useState(initial?.agent ?? agents[0] ?? '')
  const [grants, setGrants] = useState<string[]>(initial?.grants ?? ['pr'])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!agents.length && !initial) return null
  const toggle = (g: string) => setGrants(grants.includes(g) ? grants.filter((x) => x !== g) : [...grants, g])
  return (
    <form style={{ display: 'grid', gap: 10 }} onSubmit={async (e) => {
      e.preventDefault()
      setBusy(true); setError('')
      try { await call(`/api/repos/${owner}/${repo}/agents`, 'POST', { agent, grants }); refreshPublicPage(router) } catch (err) { setError((err as Error).message) }
      setBusy(false)
    }}>
      {!initial && (
        <select aria-label="Agent" disabled={!ready || busy} style={field} value={agent} onChange={(e) => setAgent(e.target.value)}>
          {agents.map((a) => <option key={a} value={a}>@{displayIdentity(a)}</option>)}
        </select>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 14 }}>
        {[['pr', 'push branches, claim issues'], ['review', 'approve, request changes'], ['queue', 'run the merge queue']].map(([g, what]) => (
          <label key={g} style={{ display: 'flex', gap: 6, alignItems: 'center' }} title={what}>
            <input type="checkbox" disabled={!ready || busy} checked={grants.includes(g)} onChange={() => toggle(g)} /> {g}
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="submit" style={initial ? secondary : primary} disabled={!ready || busy || !agent}>{busy ? 'Saving…' : initial ? 'Save grants' : 'Grant'}</button>
        {error && <span style={{ color: 'var(--bad)', fontSize: 13 }}>{error}</span>}
      </div>
    </form>
  )
}

/** Orchestrator: the agent may spawn child agents here, suspend them, and
 *  read every agent's mentions. Owners and admins only; revoking it revokes
 *  every child spawned under it. */
export function OrchestratorToggle({ owner, repo, agent, granted, children }: {
  owner: string; repo: string; agent: string; granted: boolean; children: number
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [sponsor, label] = agent.split('/')
  const change = async (grant: boolean) => {
    setBusy(true); setError('')
    try {
      if (grant) await call(`/api/repos/${owner}/${repo}/orchestrators`, 'POST', { agent })
      else await call(`/api/repos/${owner}/${repo}/orchestrators/${sponsor}/${label}`, 'DELETE')
      router.refresh()
    } catch (err) { setError((err as Error).message) }
    setBusy(false); setConfirming(false)
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {confirming ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" style={{ ...secondary, color: 'var(--bad)', borderColor: 'var(--bad)' }} disabled={busy} onClick={() => change(false)}>
            Revoke orchestrator{children ? ` and ${children} child agent${children === 1 ? '' : 's'}` : ''}
          </button>
          <button type="button" style={secondary} onClick={() => setConfirming(false)}>Keep</button>
        </div>
      ) : (
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }} title="Spawns child agents here (never wider than itself), takes them offline, reads every agent's mentions">
          <input type="checkbox" checked={granted} disabled={busy} onChange={(e) => (e.target.checked ? change(true) : setConfirming(true))} />
          orchestrator
        </label>
      )}
      {error && <span style={{ color: 'var(--bad)', fontSize: 13 }}>{error}</span>}
    </div>
  )
}

/** Take an agent offline (it leaves the channel, gets no mentions, its token
 *  answers 403) or bring it back. */
export function SuspendButton({ owner, repo, agent, suspended }: { owner: string; repo: string; agent: string; suspended: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sponsor, label] = agent.split('/')
  return (
    <div style={{ display: 'grid', gap: 6, justifyItems: 'start' }}>
      <button type="button" style={secondary} disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try { await call(`/api/repos/${owner}/${repo}/agents/${sponsor}/${label}/${suspended ? 'resume' : 'suspend'}`, 'POST', {}); router.refresh() } catch (err) { setError((err as Error).message) }
        setBusy(false)
      }}>{busy ? '…' : suspended ? 'Resume' : 'Suspend'}</button>
      {error && <span style={{ color: 'var(--bad)', fontSize: 13 }}>{error}</span>}
    </div>
  )
}
