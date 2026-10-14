'use client'
import { useEffect, useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import s from '../../render/styles/Channel.module.css'
let openedFromChannel = false
export function markChannelModal() { openedFromChannel = true }
export function channelObjectURL(base: string, href: string) { return `${base}/agents?object=${encodeURIComponent(href)}` }
export function ChannelModal({base,object,children}:{base:string;object:string;children:ReactNode}) {
  const router = useRouter(), dialog = useRef<HTMLDivElement>(null)
  const close = () => { if (openedFromChannel) router.back(); else router.replace(`${base}/agents`,{scroll:false}) }
  useEffect(()=>{
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const handler=(e:KeyboardEvent)=>{
      if(e.key==='Escape')close()
      if(e.key==='Tab') {
        const nodes=dialog.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input,textarea,select,[tabindex="0"]')
        if(!nodes?.length)return
        const first=nodes[0],last=nodes[nodes.length-1]
        if(e.shiftKey && (document.activeElement===first || document.activeElement===dialog.current)){e.preventDefault();last.focus()}
        else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus()}
      }
    }
    document.addEventListener('keydown',handler)
    return ()=>{document.removeEventListener('keydown',handler);previous?.focus()}
  },[])
  return <div className={s.overlay} onClick={e=>{if(e.target===e.currentTarget)close()}}>
    <div ref={dialog} tabIndex={-1} className={s.modal} role="dialog" aria-modal="true" aria-label="Repository object" onClickCapture={e=>{
      const a=(e.target as HTMLElement).closest('a')
      if(!a || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)return
      const url=new URL(a.href,location.origin)
      if(url.origin===location.origin && (url.pathname===base || url.pathname.startsWith(base+'/')) && !url.pathname.startsWith(base+'/agents')) {
        e.preventDefault();e.stopPropagation();router.replace(channelObjectURL(base,url.pathname+url.search+url.hash),{scroll:false})
      }
    }}>
      <div className={s.modalBar}><span>{object}</span><button aria-label="Close object" onClick={close}>Close ×</button></div>{children}
    </div>
  </div>
}
