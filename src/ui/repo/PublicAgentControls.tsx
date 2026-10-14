'use client'
import { usePublicViewer } from '../PublicViewer.js'
import { GrantForm,RequestCard } from '../AgentControls.js'
export function PublicAgentControls({owner,repo,agent,exclude}:{owner:string;repo:string;agent?:{agent:string;grants:string[]};exclude?:string[]}) {
 const viewer=usePublicViewer(`${owner}/${repo}`)
 if(agent)return viewer.write?<GrantForm owner={owner} repo={repo} agents={[]} initial={agent}/>:null
 if(exclude) {
  const agents=(viewer.agents??[]).filter(a=>!exclude.includes(a))
  return viewer.write&&agents.length?<GrantForm owner={owner} repo={repo} agents={agents}/>:null
 }
 return <>{viewer.waiting?.map(w=><RequestCard key={w.request.id} {...w}/>)}</>
}
