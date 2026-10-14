import type { Emission } from '../api/events-contract.js'
import type { ChannelMessage } from '../api/channel-contract.js'
/** Every repo event enters here from ForgeEvents.emit, including agents. */
export function systemNote(e: Emission): Omit<ChannelMessage, 'cursor'> | null {
  if (!e.repository) return null
  const p = e.payload as Record<string, any>, name = p.sender?.login ?? p.actor ?? p.receipt?.agent ?? p.pusher?.name ?? 'gild'
  const base = `/${e.repository}`
  let body = '', href = '', label = ''
  const item = p.pull_request ?? p.issue
  if (['issues','pull_request','issue_comment','pull_request_review','pull_request_review_comment'].includes(e.event) && (item?.number ?? p.number)) {
    const number = item?.number ?? p.number, pr = !!p.pull_request || !!p.issue?.pull_request || e.event.startsWith('pull_') || e.event === 'merge_queue'
    const verb = e.event === 'issue_comment' || e.event === 'pull_request_review_comment' ? 'commented on' : e.event === 'pull_request_review' ? 'reviewed' : p.action === 'assigned' ? 'claimed' : p.action === 'closed' && item?.merged ? 'merged' : p.action ?? 'updated'
    body = verb; label = `${pr ? 'PR' : 'issue'} #${number}${item?.title ? ` "${item.title}"` : ''}`; href = `${base}/${pr ? 'pulls' : 'issues'}/${number}`
  } else if (e.event === 'push') {
    if (p.ref==='refs/heads/_meta') return null // Object events describe internal metadata writes.
    body = `pushed ${String(p.ref ?? '').replace('refs/heads/', '')}`
    if (p.after && !/^0+$/.test(p.after)) { href = `${base}/commit/${p.after}`; label = p.after.slice(0,7) }
  } else if (e.event === 'workflow_run') {
    const run = p.workflow_run ?? p.workflow_job
    const id = e.event === 'workflow_run' ? run?.id : run?.run_id
    if (!id) return null
    body = `${p.action ?? 'updated'} Actions run`; href = `${base}/actions/${id}`; label = `#${id} ${run.name ?? ''}`.trim()
  } else if (e.event === 'session') {
    if (typeof p.receipt?.target !== 'string' || typeof p.receipt?.id !== 'string' || !/^(pull:[1-9][0-9]*|commit:[a-f0-9]{40})$/.test(p.receipt.target)) return null
    // Busy/idle/tool changes show as the agent's state in the participant
    // list; a line per change buried the conversation (10 Oct rehearsal).
    if (p.action === 'updated') return null
    body = `${p.action === 'ended' ? 'ended' : p.action === 'updated' ? 'updated' : 'started'} session`; href = `${base}/${p.receipt.target.startsWith('pull:') ? 'pulls/' + p.receipt.target.slice(5) : 'commit/' + p.receipt.target.slice(7)}`; label = p.receipt.id
  } else return null
  return { id: e.id, created_at: e.created_at ?? new Date().toISOString(), author: { name, kind: name.includes('/') ? 'agent' : 'human' }, reply_to:null, kind: 'system', body, link: href ? { href, label } : null }
}
