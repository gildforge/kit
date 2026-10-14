'use client'
import { useRouter } from 'next/navigation'
import { Sidebar as SidebarView } from '../render/Sidebar.js'
import { clearPrivateSources } from '../render/router.js'
import type { ProfilePicture } from '../engine/profile.js'
export function Sidebar({identity}:{identity?:{name:string;avatar?:ProfilePicture}|null}) {
  const router=useRouter()
  return <SidebarView identity={identity} onSignOut={async()=>{await clearPrivateSources().catch(()=>{});await fetch('/api/auth/signout',{method:'POST'});router.push('/');router.refresh()}}/>
}
