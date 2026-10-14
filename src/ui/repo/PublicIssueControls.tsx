'use client'
import { usePublicViewer } from '../PublicViewer.js'
import { CommentForm, IssueActions } from './IssueForms.js'
export function PublicIssueControls({ owner,repo,issue }: {owner:string;repo:string;issue:{number:number;author:string;state:string;claim:{by:string}|null}}) {
  const viewer = usePublicViewer(`${owner}/${repo}`)
  if (!viewer.name) return <p><a href={`/auth/device?next=${encodeURIComponent(`/${owner}/${repo}/issues/${issue.number}`)}`}>Sign in</a> to comment.</p>
  const actions: Parameters<typeof IssueActions>[0]['actions'] = []
  if (viewer.write || issue.author === viewer.name) actions.push(issue.state==='open'?{action:'close',label:'Close issue'}:{action:'reopen',label:'Reopen issue'})
  if (viewer.write && issue.state==='open' && !issue.claim) actions.push({action:'claim',label:'Claim it'})
  if (issue.claim && (viewer.write || issue.claim.by===viewer.name)) actions.push({action:'unclaim',label:'Release claim'})
  return <><IssueActions owner={owner} repo={repo} number={issue.number} actions={actions}/><CommentForm owner={owner} repo={repo} number={issue.number}/></>
}
