import type { SessionObservation } from '../../engine/sessions-contract.js'
export const RUNTIME_STALE_MS=90_000
/** Reports describe observations, never grant authority or certify isolation. */
export function RuntimeObservation({session,now,connected}:{session:SessionObservation;now?:number;connected?:boolean}) {
  const runtime=session.runtime
  if (!runtime) return <p>Runtime not reported</p>
  const last=runtime.observed_at
  const stale=now!==undefined && now-Math.min(Date.parse(last),Date.parse(session.updated_at))>RUNTIME_STALE_MS
  const status=session.closed || session.ended_at ? 'Stopped' : stale ? 'Stale · last reported running' : now===undefined ? 'Last reported running' : 'Reported running'
  return <section aria-label="Agent runtime profile" style={{display:'grid',gap:4,fontSize:12,overflowWrap:'anywhere',whiteSpace:'normal',minWidth:0}}>
    <strong>{runtime.mode} · {status}</strong>
    <span>Worker: {runtime.worker.name}</span>
    <span>Machine ID: <code>{runtime.worker.id}</code></span>
    <span>Host: {runtime.host.os}{runtime.host.version ? ` ${runtime.host.version}` : ''}</span>
    {runtime.mode==='VM' && <span>Guest: {runtime.guest ? `${runtime.guest.os} ${runtime.guest.version}` : 'Not observed'}</span>}
    <span>Last observation: <time dateTime={last}>{last}</time></span>
    <span>Last update: <time dateTime={session.updated_at}>{session.updated_at}</time></span>
    {connected===false && <span>Updates disconnected</span>}
    <small>Worker-reported observation</small>
  </section>
}
