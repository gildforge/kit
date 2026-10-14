'use client'
import { displayIdentity } from '../../engine/channel/identity.js'
import { stateLabel } from '../../engine/channel/label.js'
import { RuntimeObservation } from './RuntimeObservation.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ChannelMessage, ChannelParticipant, ChannelPage, ChannelInitial } from '../../engine/api/channel-contract.js'
import { usePublicViewer } from '../PublicViewer.js'
import { channelViewer } from '../../engine/channel/viewer.js'
import { channelObjectURL, markChannelModal } from './ChannelModal.js'
import s from '../../render/styles/Channel.module.css'
export function nickColor(name:string) {
  let hash=0;for(const ch of name)hash=(hash*31+ch.charCodeAt(0))|0
  return ['var(--lane-1)','var(--lane-2)','var(--lane-3)','var(--accent)','var(--ok)'][Math.abs(hash)%5]
}
async function json(url:string,init?:RequestInit) {const r=await fetch(url,init);const d=await r.json();if(!r.ok)throw Error(d.message ?? d.error ?? `Request failed (${r.status})`);return d}
export type ChannelBootstrap = { page: ChannelPage; people: { participants: ChannelParticipant[]; can_post: boolean; viewer: string | null } }
export function RepoChannel({owner,repo,initial,bootstrap}:{owner:string;repo:string;initial?:ChannelInitial;bootstrap?:Promise<ChannelBootstrap>}) {
  const base=`/${owner}/${repo}`,api=`/api/v1/repos/${owner}/${repo}/channel`,router=useRouter()
  const [messages,setMessages]=useState<ChannelMessage[]>(initial?.page.messages ?? []),[body,setBody]=useState(''),[error,setError]=useState(''),[connected,setConnected]=useState(false),[showPeople,setShowPeople]=useState(false),[before,setBefore]=useState<string|null>(initial?.page.before ?? null),[busy,setBusy]=useState(false)
  const [people,setPeople]=useState(()=>({participants:initial?.participants ?? [],viewer:initial?.viewer ?? null,can_post:initial?.can_post ?? false,resolved:!!initial}))
  const [runtimeNow,setRuntimeNow]=useState<number>()
  useEffect(()=>{setRuntimeNow(Date.now());const timer=setInterval(()=>setRuntimeNow(Date.now()),30_000);return ()=>clearInterval(timer)},[])
  const {participants,viewer,can_post:canPost}=people
  const island=usePublicViewer(`${owner}/${repo}`,initial ? {name:initial.viewer,channel:initial} : undefined)
  useEffect(()=>{if(island.channel)setPeople({...island.channel,resolved:true})},[island.channel])
  const panel=useRef<HTMLElement>(null),log=useRef<HTMLDivElement>(null),cursor=useRef(initial?.page.cursor ?? '0'),follow=useRef(true)
  const add=(items:ChannelMessage[])=>setMessages(old=>[...new Map([...old,...items].map(m=>[m.cursor,m])).values()].sort((a,b)=>Number(a.cursor)-Number(b.cursor)))
  useLayoutEffect(()=>{
    const fit=()=>{if(panel.current)panel.current.style.height=Math.max(160,(window.visualViewport?.height ?? innerHeight)-panel.current.getBoundingClientRect().top-16)+'px'}
    fit()
    const observer=new ResizeObserver(fit)
    if(panel.current?.parentElement)observer.observe(panel.current.parentElement)
    window.addEventListener('resize',fit);window.visualViewport?.addEventListener('resize',fit)
    void document.fonts.ready.then(fit)
    return()=>{observer.disconnect();window.removeEventListener('resize',fit);window.visualViewport?.removeEventListener('resize',fit)}
  },[])
  useEffect(()=>{
    const requests=new AbortController()
    let stopped=false,socket:WebSocket|undefined,retry:ReturnType<typeof setTimeout>|undefined,ping:ReturnType<typeof setInterval>|undefined
    const connect=()=>{
      if(stopped)return
      socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${api}/stream?after=${cursor.current}`)
      socket.onopen=()=>{setConnected(true);setError('');ping=setInterval(()=>{if(socket?.readyState===WebSocket.OPEN)socket.send('ping')},25000)}
      socket.onmessage=e=>{const d=JSON.parse(e.data);if(d.type==='ready'){add(d.messages);const last=d.messages.at(-1)?.cursor;if(last)cursor.current=String(Math.max(Number(cursor.current),Number(last)));if(d.after){void catchUp().catch(e=>{if(!stopped)setError(e.message)})}}else if(d.type==='message'){add([d.message]);cursor.current=String(Math.max(Number(cursor.current),Number(d.message.cursor)))}else if(d.type==='presence'){setPeople(old=>({...channelViewer((d.participants ?? old.participants).map((p:ChannelParticipant)=>({...p,online:d.online.includes(p.name)})),old.viewer,d.can_post ?? old.can_post),resolved:old.resolved}))}}
      socket.onclose=()=>{setConnected(false);clearInterval(ping);if(!stopped)retry=setTimeout(connect,2000)}
      socket.onerror=()=>socket?.close()
    }
    const catchUp=async()=>{let next=cursor.current;do {const page:ChannelPage=await json(`${api}/messages?after=${next}&limit=200`,{signal:requests.signal});if(stopped)return;add(page.messages);next=page.messages.at(-1)?.cursor ?? next;cursor.current=String(Math.max(Number(cursor.current),Number(next)));if(!page.after)break}while(!stopped)}
    // Server props paint immediately. Legacy documents seed the cursor from
    // navigation's prefetched snapshot before joining the live stream.
    if(initial)connect()
    else {
      const snapshot=bootstrap ?? Promise.all([json(`${api}/messages`,{signal:requests.signal}),json(`${api}/participants`,{signal:requests.signal})]).then(([page,people])=>({page,people}))
      void snapshot.then(({page,people})=>{if(stopped)return;add(page.messages);cursor.current=String(Math.max(Number(cursor.current),Number(page.cursor)));setBefore(page.before);setPeople({...people,resolved:true});connect()}).catch(e=>{if(!stopped)setError(e.message)})
    }
    return()=>{stopped=true;requests.abort();clearTimeout(retry);clearInterval(ping);socket?.close()}
  },[api,initial,bootstrap])
  useEffect(()=>{if(follow.current && log.current)log.current.scrollTop=log.current.scrollHeight},[messages])
  return <section ref={panel} className={s.channel} aria-label="Repository channel">
    <div className={s.main}>
      <div className={s.bar}><strong>#{owner}/{repo}</strong><span role="status" aria-label="Channel connection"><span className={s.connection}>{connected?'live':'connecting'}</span><button className={`${s.button} ${s.toggle}`} aria-expanded={showPeople} onClick={()=>setShowPeople(!showPeople)}>Participants ({participants.length})</button></span></div>
      <div ref={log} className={s.log} role="log" aria-label="Channel messages" aria-live="polite" onScroll={()=>{if(log.current)follow.current=log.current.scrollHeight-log.current.scrollTop-log.current.clientHeight<60}}>
        {before && <button className={s.button} onClick={async()=>{try{follow.current=false;const page=await json(`${api}/messages?before=${before}`);const height=log.current?.scrollHeight ?? 0;add(page.messages);setBefore(page.before);requestAnimationFrame(()=>{if(log.current)log.current.scrollTop+=log.current.scrollHeight-height})}catch(e){setError((e as Error).message)}}}>Earlier messages ↑</button>}
        {messages.map(m=><div key={m.cursor} className={`${s.line} ${m.kind==='system'?s.system:''} ${m.kind==='system' && m.author.kind==='human'?s.quiet:''}`} data-kind={m.kind}>
          <time className={s.time} title={m.created_at} dateTime={m.created_at}>{new Date(m.created_at).toISOString().slice(11,19)}</time>{m.kind==='system' ? <> * <span style={{color:nickColor(m.author.name)}}>{displayIdentity(m.author.name)}</span> {m.body} {m.link && <a href={channelObjectURL(base,m.link.href)} onClick={e=>{if(e.metaKey||e.ctrlKey)return;e.preventDefault();markChannelModal();router.push(channelObjectURL(base,m.link!.href),{scroll:false})}}>{m.link.label}</a>}</> : <><span className={s.nick} style={{color:nickColor(m.author.name)}}>{displayIdentity(m.author.name)}</span><span className={s.text}>{m.body}</span></>}
        </div>)}
      </div>
      {error && <div className={s.error} role="alert">{error}</div>}
      {canPost ? <form className={s.input} onSubmit={async e=>{e.preventDefault();if(!body.trim()||busy)return;setBusy(true);try{const m=await json(`${api}/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body})});follow.current=true;add([m]);setBody('');setError('')}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}><span style={{color:nickColor(viewer ?? '')}}>{displayIdentity(viewer ?? '')} &gt;</span><input aria-label="Channel message" value={body} onChange={e=>setBody(e.target.value)} maxLength={4000} autoComplete="off" disabled={busy}/></form> : <div className={s.input}>{viewer ? <span>Read-only · {displayIdentity(viewer)} can read this channel; posting needs write access{participants.find(p=>p.prefix==='@')?` from ${displayIdentity(participants.find(p=>p.prefix==='@')!.name)}`:''}</span> : <a href={`/auth/device?next=${encodeURIComponent(`${base}/agents`)}`}>Sign in to speak</a>}</div>}
    </div>
    <aside className={`${s.participants} ${showPeople?s.open:''}`} aria-label="Participants"><h3>Participants</h3>{island.write && <div style={{display:'flex',flexWrap:'wrap',gap:'6px 12px'}}><a href={`${base}/settings/agents`} className={s.button}>Manage agents</a><a href={`${base}/agents/package`} className={s.button}>Package profiles</a></div>}<ul>{!people.resolved && !viewer && <li className={s.viewerSkeleton} aria-label="Loading viewer"><span className={s.dot}/><span aria-hidden="true"/></li>}{participants.map((p,i)=><li key={p.name} data-kind={p.kind} className={p.kind==='agent' && participants[i-1]?.kind!=='agent'?s.divider:undefined} title={[p.sponsor?`Sponsored by ${displayIdentity(p.sponsor)}`:'Human',p.prefix==='%'?'Orchestrator: spawns and suspends agents, reads every mention':'',p.scopes.length?`Scopes: ${p.scopes.join(', ')}`:p.prefix==='@'?'Repository admin':p.prefix==='+'?'Repository writer':'Repository reader'].filter(Boolean).join('\n')}><span className={`${s.dot} ${p.online?s.online:''}`} aria-label={p.online?'Online':'Offline'}/><span style={{color:nickColor(p.name)}}>{p.prefix}{displayIdentity(p.name)}</span>{p.kind === 'agent' && p.state && <small className={s.agentState}>{stateLabel(p.state)}</small>}{p.kind==='agent' && p.session && <details style={{gridColumn:'1 / -1'}}><summary>Runtime profile</summary><RuntimeObservation session={p.session} now={runtimeNow} connected={runtimeNow===undefined ? undefined : connected}/></details>}</li>)}</ul></aside>
  </section>
}
