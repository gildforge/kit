'use client'
import { RepoIsland } from '../../render/RepoIsland.js'
import Link from '../Link.js'
import { usePublicViewer } from '../PublicViewer.js'
import s from '../../render/styles/repo.module.css'
type CreateProps={path:string;label:string;anonymous:string}
export function CreateItemView({path,label,anonymous}:CreateProps) {
 const viewer=usePublicViewer()
 return <Link href={viewer.name?path:'/auth/device?next='+encodeURIComponent(path)} className={viewer.name?s.primary:s.secondary}>{viewer.name?label:anonymous}</Link>
}
export function PublicCreateItem(props:CreateProps) {
 return <RepoIsland kind="create" props={props}><CreateItemView {...props}/></RepoIsland>
}
