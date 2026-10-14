import { SESSION_MAX_AGE } from '../../engine/session-cookie.js'
import type { Context, Result } from '../api/dispatch.js'
import type { ForgeStore } from '../backend.js'
import type { ReadServices } from '../repo-read.js'
import { channelAccess, mentionedAgents } from './participants.js'
import { channelFrom, type ChannelBindings } from './binding.js'
import { channelViewer } from '../../engine/channel/viewer.js'
import { ApiError } from '../../engine/api/errors.js'
import { channelQuery } from '../../engine/api/channel-contract.js'
export function channelHandler(s: ReadServices & {store: ForgeStore}, bindings: () => Promise<ChannelBindings>, access = channelAccess) {
  return async (c: Context): Promise<Result> => {
    const {owner,repo} = c.params, {policy,canPost} = await access(s,owner,repo,c.principal)
    const channel = channelFrom(await bindings(), (await s.store.settings.state(`${owner}/${repo}`)).id)
    if (c.route.id === 'channelMessages') return {data:await channel.page(channelQuery.parse(c.query)),noStore:true}
    if (c.route.id === 'channelParticipants') {
      const start=performance.now()
      const participants=await channel.participants(`${owner}/${repo}`,policy.acl)
      return {data:channelViewer(participants,c.principal.name || null,canPost),headers:{'server-timing':`participants;dur=${(performance.now()-start).toFixed(2)}`},noStore:true}
    }
    if (c.route.id === 'channelPost') {
      if (!canPost) throw new ApiError(403,'Channel posting requires repository write or channel:write access')
      const participants = await channel.participants(`${owner}/${repo}`,policy.acl)
      const agents = mentionedAgents(c.body.body, participants.filter(p=>p.kind==='agent').map(p=>p.name))
      return {data:await channel.post(`${owner}/${repo}`,c.principal.name,c.body.body,agents,c.body.reply_to)}
    }
    if (c.request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new ApiError(426,'WebSocket upgrade required')
    const origin = c.request.headers.get('origin')
    if (origin && origin !== new URL(c.request.url).origin) throw new ApiError(403,'Cross-origin WebSocket refused')
    const headers = new Headers(c.request.headers)
    let expires: number | null = null
    if (!c.principal.anonymous && !c.request.headers.has('authorization')) {
      try {const raw=c.request.headers.get('cookie')?.match(/(?:^|;\s*)gild_session=([^;]+)/)?.[1];expires=Date.parse(JSON.parse(Buffer.from(raw!.split('.')[0],'base64url').toString()).at)+SESSION_MAX_AGE*1000} catch {throw new ApiError(401,'Session expired')}
    }
    headers.set('x-channel-viewer',JSON.stringify({expires,repository:`${owner}/${repo}`,principal:c.principal,token:c.request.headers.has('authorization')}))
    return {data:null,response:await channel.fetch(new Request(c.request,{headers})),noStore:true}
  }
}
