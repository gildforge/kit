'use client'
import { usePublicViewer } from '../PublicViewer.js'
import { PullActions, ReviewForm } from './PullForms.js'
export function PublicPullControls({ owner,repo,pull,queuePos,approvals,changes }: { owner:string;repo:string;pull:{number:number;author:string;state:string;conflicts?:boolean};queuePos:number;approvals:number;changes:number }) {
  const viewer = usePublicViewer(`${owner}/${repo}`)
  if (!viewer.name) return <p><a href={`/auth/device?next=${encodeURIComponent(`/${owner}/${repo}/pulls/${pull.number}`)}`}>Sign in</a> to review.</p>
  const actions: Parameters<typeof PullActions>[0]['actions'] = []
  if (pull.state==='open' && viewer.write && queuePos<0 && approvals && !changes) actions.push({action:'queue',label:pull.conflicts?'Queue again after updating the branch':'Add to merge queue',primary:true})
  if (pull.state==='open' && viewer.write && queuePos>=0) actions.push({action:'dequeue',label:'Remove from queue'})
  if ((viewer.write || pull.author===viewer.name) && pull.state!=='merged') actions.push(pull.state==='open'?{action:'close',label:'Close'}:{action:'reopen',label:'Reopen'})
  return <><PullActions owner={owner} repo={repo} number={pull.number} actions={actions}/>{pull.state==='open' && <ReviewForm owner={owner} repo={repo} number={pull.number} canApprove={!!viewer.write && pull.author!==viewer.name} canRequestChanges={!!viewer.write}/>}</>
}
