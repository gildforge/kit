'use client'
import { useEffect,useState } from 'react'
import Link from 'next/link'
import type { z } from 'zod'
import type { importStatus } from '../engine/api/import-contract.js'
import { usePublicViewer } from './PublicViewer.js'
export function ImportStatus({owner,repo,canManage=false}:{owner:string;repo:string;canManage?:boolean}) {
  const viewer=usePublicViewer(`${owner}/${repo}`,{name:null,write:canManage})
  canManage=viewer.write??canManage
  const [status,setStatus]=useState<z.infer<typeof importStatus>|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[sourceToken,setSourceToken]=useState('')
  const url=`/api/repos/${owner}/${repo}/import`
  useEffect(()=>{let cancelled=false,timer:ReturnType<typeof setTimeout>;async function refresh(){let delay=5000;try{const r=await fetch(url),data=await r.json();if(!r.ok)throw Error(data.error??'Could not load import');if(!cancelled){setStatus(data);setError('');delay=['queued','running'].includes(data.state)?2000:30000}}catch(e){if(!cancelled)setError((e as Error).message)}finally{if(!cancelled)timer=setTimeout(refresh,delay)}}void refresh();return()=>{cancelled=true;clearTimeout(timer)}},[url])
  async function action(operation:string){setBusy(true);try{const r=await fetch(url+'/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(operation==='retry'?{source_token:sourceToken||undefined}:{})}),data=await r.json();if(!r.ok)throw Error(data.error??'Import operation failed');setStatus(data);setSourceToken('');setError('')}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  return <section><h1>Import {owner}/{repo}</h1>{error&&<p role="alert">{error}</p>}{status&&<>
    <p>Source: <a href={status.source}>{status.source}</a></p>
    <p role="status">{status.state} · {status.progress.phase} · {status.progress.message} · {status.progress.completed}</p>
    {status.state==='queued'&&<p>Waiting for an eligible owner runner.{canManage&&<> <Link href="/settings/runners">Manage runners</Link> or run <code>gild repo resume {owner}/{repo}</code>.</>}</p>}
    {status.summary&&<p>{status.summary.branches} branches · {status.summary.tags} tags · {status.summary.commits} commits · {status.summary.records} metadata records · {(status.summary.elapsed_ms/1000).toFixed(1)} seconds</p>}
    {status.error&&<p>{status.error}</p>}
    {status.next_sync&&status.mirror&&<p>Next source sync: <time>{status.next_sync}</time></p>}
    {status.state==='cutover'&&<p>The source is retained as a read-only reference. Work continues on gild.</p>}
    {status.warnings.length>0&&<><h2>Actions compatibility</h2><ul>{status.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul><a href="https://github.com/gildforge/gild-site/blob/main/docs/actions/README.md">Actions support table</a></>}
    {canManage&&status.state==='failed'&&<><label>Source access token (optional)<input type="password" autoComplete="off" value={sourceToken} onChange={e=>setSourceToken(e.target.value)} /></label><button disabled={busy} onClick={()=>action('retry')}>Resume import</button></>}
    {canManage&&status.state==='mirroring'&&<button disabled={busy} onClick={()=>action('cutover')}>Cut over to gild</button>}
    <p><Link href={`/${owner}/${repo}`}>Open repository</Link></p>
  </>}</section>
}
