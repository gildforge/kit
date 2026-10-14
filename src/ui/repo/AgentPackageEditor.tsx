'use client'
import {useState} from 'react'
import {parseAgentPackageManifest,type AgentPackageManifest} from '../../engine/api/agent-package-contract.js'

interface Snapshot { text:string; blob:string; commit:string; manifest:AgentPackageManifest }
export function AgentPackageEditor({owner,repo,canEdit}:{owner:string;repo:string;canEdit:boolean}) {
 const [branch,setBranch]=useState('main'),[loadedBranch,setLoadedBranch]=useState(''),[snapshot,setSnapshot]=useState<Snapshot>(),[draft,setDraft]=useState(''),[preview,setPreview]=useState<AgentPackageManifest>(),[editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('')
 const load=async()=>{
  if(busy)return
  setBusy(true);setError('');setMessage('Pending · reading gild.json')
  try {
   const response=await fetch(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/gild.json?ref=${encodeURIComponent(branch)}`,{cache:'no-store'})
   const file=await response.json()
   if(!response.ok)throw Error(response.status===503?'Pending · repository content is not ready. Retry when it is prepared.':file.error??file.message??`Read refused (${response.status})`)
   if(file.type!=='file'||file.encoding!=='base64'||typeof file.content!=='string'||file.size>128*1024)throw Error('gild.json must be a UTF-8 file of at most 128 KiB')
   const text=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(file.content.replace(/\s/g,'')),c=>c.charCodeAt(0)))
   const manifest=parseAgentPackageManifest(text),commit=new URL(file.html_url).pathname.match(/\/blob\/([a-f0-9]{40})\//)?.[1]
   if(!commit||!/^[a-f0-9]{40}$/.test(file.sha))throw Error('The file read did not identify an immutable commit and blob')
   setSnapshot({text,blob:file.sha,commit,manifest});setDraft(text);setPreview(manifest);setLoadedBranch(branch);setEditing(false);setMessage('Committed package loaded')
  }catch(e){setMessage('');setError((e as Error).message)}finally{setBusy(false)}
 }
 const validate=()=>{try{const manifest=parseAgentPackageManifest(draft);setPreview(manifest);setError('');setMessage('Valid package · requested permissions are declarations');return manifest}catch(e){setError((e as Error).message);setMessage('');return null}}
 const save=async()=>{
  if(busy||!snapshot||!canEdit)return
  const manifest=validate();if(!manifest)return
  setBusy(true);setMessage('Pending · saving gild.json')
  try{
   const response=await fetch(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/agent-package`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({branch:loadedBranch,expected_head:snapshot.commit,text:draft})})
   const result=await response.json()
   if(!response.ok)throw Error(result.error??result.message??`Save refused (${response.status})`)
   if(result.branch!==loadedBranch||!/^[a-f0-9]{40}$/.test(result.commit)||!/^[a-f0-9]{40}$/.test(result.blob))throw Error('The save was not confirmed; reload before retrying')
   setSnapshot({text:draft,commit:result.commit,blob:result.blob,manifest});setPreview(manifest);setEditing(false);setMessage('Saved gild.json to '+loadedBranch)
  }catch(e){setMessage('');setError((e as Error).message)}finally{setBusy(false)}
 }
 return <section aria-label="Agent package" style={{display:'grid',gap:14,maxWidth:1000,padding:'20px 0'}}>
  <h2 style={{margin:0}}>Package profiles</h2>
  <p style={{margin:0}}>Read the agents and package references declared in <code>gild.json</code>. Editing these definitions does not grant access or launch an agent.</p>
  <form onSubmit={e=>{e.preventDefault();void load()}} style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
   <label>Branch <input aria-label="Package branch" value={branch} onChange={e=>setBranch(e.target.value)} disabled={busy||editing} required maxLength={255}/></label>
   <button disabled={busy||editing}>{snapshot?'Reload manifest':'Open manifest'}</button>
  </form>
  {error&&<p role="alert" style={{color:'var(--bad)',whiteSpace:'pre-wrap'}}>{error}</p>}
  {message&&<p role="status">{message}</p>}
  {snapshot&&<>
   <p style={{margin:0,overflowWrap:'anywhere'}}>Package <strong>{snapshot.manifest.name}</strong> · {loadedBranch} · commit <code>{snapshot.commit}</code></p>
   <div aria-label="Declared agent members" style={{display:'grid',gap:10}}>
    {Object.entries(preview?.agents??snapshot.manifest.agents).map(([name,agent])=><article key={name} style={{border:'1px solid var(--rule)',padding:12,overflowWrap:'anywhere'}}>
     <strong>{name}</strong>{'dependency' in agent?<p>Reference: <code>{agent.dependency}</code> · member <code>{agent.member}</code></p>:<><p>Runtime: {agent.runtime}{agent.model&&<> · model {agent.model}</>}{agent.effort&&<> · effort {agent.effort}</>}</p>{agent.instructions&&<p>Instructions: <code>{agent.instructions}</code></p>}{!!agent.skills?.length&&<p>Skills: {agent.skills.join(', ')}</p>}{!!agent.assets?.length&&<p>Assets: {agent.assets.join(', ')}</p>}{!!agent.requestedPermissions?.length&&<p>Requested permissions: {agent.requestedPermissions.join(', ')} (declarations)</p>}</>}
    </article>)}
   </div>
   <div aria-label="Package dependencies">
    <h3>Package references</h3>
    {Object.entries(preview?.dependencies??snapshot.manifest.dependencies).map(([alias,d])=><p key={alias} style={{overflowWrap:'anywhere'}}><code>{alias}</code> · {d.kind} · <a href={d.repository} rel="noreferrer">{d.repository}</a> · ref <code>{d.ref}</code>{d.bundlePath&&<> · path <code>{d.bundlePath}</code></>}</p>)}
    {Object.keys(preview?.dependencies??snapshot.manifest.dependencies).length===0&&<p>No dependencies declared.</p>}
   </div>
   {canEdit&&!editing&&<button onClick={()=>{setEditing(true);setMessage('');setError('')}}>Edit manifest</button>}
   {!canEdit&&<p>Read-only · repository write access is required to edit.</p>}
   {editing&&<form onSubmit={e=>{e.preventDefault();void save()}} style={{display:'grid',gap:10}}>
    <label>Manifest JSON <textarea aria-label="Manifest JSON" value={draft} onChange={e=>{setDraft(e.target.value);setPreview(undefined);setMessage('')}} rows={18} maxLength={128*1024} spellCheck={false} disabled={busy} style={{width:'100%',fontFamily:'monospace'}}/></label>
    <div style={{display:'flex',gap:8}}><button type="button" disabled={busy} onClick={validate}>Validate edits</button><button disabled={busy}>Save manifest</button><button type="button" disabled={busy} onClick={()=>{setDraft(snapshot.text);setPreview(snapshot.manifest);setEditing(false);setMessage('Edits discarded');setError('')}}>Cancel edits</button></div>
    <p>Save commits only <code>gild.json</code> to {loadedBranch}. If the branch changed since this read, saving is refused and your edits stay here.</p>
   </form>}
  </>}
 </section>
}
