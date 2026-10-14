'use client'
import { createContext, useContext } from 'react'
import { IdentityView } from '../presentation/Headers.js'
import { SiteSignIn } from './SiteSignIn.js'
import { Picture } from './Picture.js'
import type { ProfilePicture } from '../engine/profile.js'
import type { ChannelPeople } from '../engine/api/channel-contract.js'
export interface Viewer { channel?: ChannelPeople; name: string | null; picture?: ProfilePicture; write?: boolean; contributor?: boolean; count?: number; starred?: boolean; agents?: string[]; waiting?: Parameters<typeof import('./AgentControls.js').RequestCard>[0][] }
interface Viewers { viewer?: Viewer; repositories: Record<string, Viewer> }
const ViewerContext = createContext<Viewers>({ repositories: {} })
/** The viewer, resolved by the server in the page's own render (RSC) and
 *  handed down: no client fetch. A stored anonymous page renders anonymous. */
export function ViewerProvider({ viewer, children }: { viewer: Viewer; children: React.ReactNode }) {
  const outer = useContext(ViewerContext)
  return <ViewerContext.Provider value={{ ...outer, viewer }}>{children}</ViewerContext.Provider>
}
/** Per-repository viewer state (write access, stars), from the same batch
 *  that decided the repository's privacy. */
export function RepoViewerProvider({ repository, value, children }: { repository: string; value: Viewer; children: React.ReactNode }) {
  const outer = useContext(ViewerContext)
  return <ViewerContext.Provider value={{ ...outer, repositories: { ...outer.repositories, [repository.toLowerCase()]: value } }}>{children}</ViewerContext.Provider>
}
export function usePublicViewer(repository?: string, initial?: Viewer): Viewer {
  const { viewer, repositories } = useContext(ViewerContext)
  const repo = repository ? repositories[repository.toLowerCase()] : undefined
  return { name: null, ...initial, ...viewer, ...repo }
}
/** The SiteHeader avatar/name pill. */
export function PublicIdentity({ initial }: { initial?: Viewer }) {
  const viewer = usePublicViewer(undefined, initial)
  return viewer.name ? <IdentityView name={viewer.name} picture={<Picture name={viewer.name} picture={viewer.picture} size={22}/>} /> : <SiteSignIn />
}
