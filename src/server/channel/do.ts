import { SocketAuthorization, AUTHORIZATION_MS } from '../../engine/channel/authorization.js'
import { type ChannelState } from '../../engine/channel/state.js'
import { decodeCurrentSession, saveCurrentSession } from '../../engine/channel/session.js'
import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectState, D1Database, WebSocket as WorkerSocket } from '@cloudflare/workers-types'
declare const WebSocketPair: { new(): {0: WorkerSocket;1: WorkerSocket} }
import { verifyStoredTokenHash } from '../token-verifier.js'
import { d1RepoReads, d1Store } from '../drivers/d1.js'
import { mayRead, privateAcl } from '../repo-read.js'
import { hasScope, permitsRepo, type Principal } from '../../engine/api/scopes.js'
import { hubFrom, type EventBindings } from '../events/binding.js'
import type { Emission } from '../../engine/api/events-contract.js'
import type { SQL } from '../../engine/repo-index-store.js'
import { prefetched } from '../repo-context.js'
import { channelPermission, participantsFrom, type ParticipantFacts } from './participants.js'
import type { RepoAccess } from '../repo-read.js'
import { ApiError } from '../../engine/api/errors.js'
import { ChannelStore } from '../../engine/channel/store.js'
import { systemNote } from '../../engine/channel/system.js'
import type { ChannelMessage, ChannelQuery } from '../../engine/api/channel-contract.js'
export const AGENT_RUN_LIMIT = 20
interface SocketIdentity { repository: string; principal: Principal; token: boolean; seen: number; expires: number | null }
export class RepoChannel extends DurableObject<EventBindings & { DB: D1Database }> {
  private authorization = new SocketAuthorization<WorkerSocket>()
  private log: ChannelStore
  private repository: string | null = null
  private roster: {key:string;facts:Promise<ParticipantFacts>} | null = null
  /** D1's generation and the exact ACL key fence cached facts; online/state are live. */
  async participants(repository:string,acl:RepoAccess['acl']) {
    this.repository=repository
    const [owner,repo]=repository.split('/')
    const [revision,online]=await Promise.all([this.env.DB.prepare('SELECT revision FROM channel_revision WHERE id=1').first<{revision:number}>(),this.online()])
    const key=JSON.stringify([repository,acl,revision?.revision,online.filter(n=>n.includes('/'))])
    if (!this.roster || this.roster.key!==key) {
      const facts=d1Store(this.env.DB).channelFacts!(owner,repo,acl,online)
      const entry={key,facts}
      this.roster=entry
      facts.catch(()=>{if(this.roster===entry)this.roster=null})
    }
    const facts=await this.roster.facts
    // Expiry is evaluated by participantsFrom on every view; immutable facts
    // need no timer rebuild. A primary generation change replaces them.
    const current=this.currentSessions()
    return participantsFrom(facts,owner,repo,acl,online).map(p=>({...p,state:current[p.name]?.state ?? null,...(current[p.name]?.session ? {session:current[p.name].session} : {})}))
  }
  async snapshot(repository:string,acl:RepoAccess['acl']) {
    const participants=await this.participants(repository,acl)
    return {page:this.page({limit:50}),participants}
  }
  constructor(ctx: DurableObjectState, env: EventBindings & { DB: D1Database }) {
    super(ctx as never, env)
    this.repository=(this.sockets()[0]?.deserializeAttachment() as SocketIdentity | null)?.repository ?? null
    this.log = new ChannelStore(ctx.storage.sql as unknown as SQL)
    this.log.sql.exec("CREATE TABLE IF NOT EXISTS channel_states(agent TEXT PRIMARY KEY,json TEXT NOT NULL,activity INTEGER NOT NULL)")
  }
  page(q: ChannelQuery) { return this.log.page(q) }
  async post(repository: string, author: string, body: string, agents: string[], replyTo?: string) {
    let message!: ChannelMessage
    const notes: ChannelMessage[] = []
    const agent = author.includes('/')
    this.ctx.storage.transactionSync(() => {
      if (replyTo && (Number(replyTo) > this.log.sequence() || ![...this.log.sql.exec('SELECT seq FROM channel_log WHERE seq=?', Number(replyTo))].length)) throw new ApiError(422,'reply_to must be a cursor in this channel')
      this.log.rate(author)
      message = this.log.append(crypto.randomUUID(), { id: crypto.randomUUID(), created_at: new Date().toISOString(), author: { name: author, kind: agent ? 'agent' : 'human' }, kind:'message', reply_to:replyTo ?? null, body, link:null })
      // Two agents must not keep each other busy forever: after AGENT_RUN_LIMIT
      // agent messages in a row, mentions are stored but not delivered until a human posts.
      const run = agent ? this.log.agentRun(AGENT_RUN_LIMIT + 2) : 0
      if (run === AGENT_RUN_LIMIT + 1) notes.push(this.log.append('guard:' + message.cursor, { id: crypto.randomUUID(), created_at: new Date().toISOString(), author: { name: 'gild', kind: 'human' }, kind:'system', reply_to:null, body:`Agent mentions paused after ${AGENT_RUN_LIMIT} agent messages in a row; a person posting resumes them`, link:null }))
      if (run <= AGENT_RUN_LIMIT) for (const target of agents) {
        if (target === author) continue
        const e: Emission = { id: `mention:${message.id}:${target}`, event:'channel.mention', repository, audience: target, payload:{ repository:{ full_name:repository }, message, author:message.author, agent:target, history_cursor:message.cursor } }
        this.log.sql.exec('INSERT OR IGNORE INTO channel_mentions VALUES (?,?)', e.id, JSON.stringify(e))
      }
    })
    await this.broadcast({ type:'message', message })
    for (const note of notes) await this.broadcast({ type:'message', message:note })
    await this.schedule(1000)
    await this.flushMentions()
    return message
  }
  async flushMentions() {
    for (const row of this.log.sql.exec<{id:string;json:string}>('SELECT id,json FROM channel_mentions LIMIT 100')) {
      await hubFrom(this.env).emit(JSON.parse(row.json))
      this.log.sql.exec('DELETE FROM channel_mentions WHERE id=?', row.id)
    }
  }
  /** A system note written by the service itself (suspend, resume), once per source. */
  async note(source: string, actor: string, body: string) {
    const fresh = ![...this.log.sql.exec('SELECT seq FROM channel_log WHERE source=?', source)].length
    const message = this.log.append(source, { id: crypto.randomUUID(), created_at: new Date().toISOString(), author: { name: actor, kind: actor.includes('/') ? 'agent' : 'human' }, kind:'system', reply_to:null, body, link:null })
    if (fresh) await this.broadcast({ type:'message', message })
    return message
  }
  currentSessions() {
    return Object.fromEntries([...this.log.sql.exec<{agent:string;json:string}>('SELECT agent,json FROM channel_states')].flatMap(row => {
      const current=decodeCurrentSession(row.json)
      return current ? [[row.agent,current]] : []
    }))
  }
  states(): Record<string, ChannelState> {
    return Object.fromEntries(Object.entries(this.currentSessions()).map(([agent,current])=>[agent,current.state]))
  }
  private async schedule(delay: number) {
    const next = Date.now() + delay, alarm = await this.ctx.storage.getAlarm()
    if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next)
  }
  async accessChanged() {
    this.authorization.clear()
    this.roster=null
    await this.broadcast({type:'presence',online:await this.online()})
  }
  async system(e: Emission) {
    // ACL writes are _meta pushes; all pushes invalidate before any fan-out.
    if (e.event === 'push') {
      await this.accessChanged()
    }
    const note = systemNote(e)
    // State updates have no channel line, but still update the roster.
    if (e.event === 'session') {
      const receipt = e.payload.receipt as Record<string, unknown> | undefined
      if (receipt && this.ctx.storage.transactionSync(()=>saveCurrentSession(this.log.sql,receipt))) {
        await this.broadcast({type:'presence',online:await this.online()})
      }
    }
    if (!note) return
    const existing = [...this.log.sql.exec('SELECT seq FROM channel_log WHERE source=?', e.id)].length
    const message = this.log.append(e.id, note)
    if (!existing) await this.broadcast({ type:'message', message })
  }
  private sockets() { return this.ctx.getWebSockets() as unknown as WorkerSocket[] }
  private async valid(ws: WorkerSocket) {
    const identity = ws.deserializeAttachment() as SocketIdentity
    if (!identity || (identity.expires!==null && identity.expires<=Date.now()) || Date.now()-identity.seen > 90000) { ws.close(1008,'Presence expired'); return false }
    return this.authorization.valid(ws, async () => {
    const st = d1Store(this.env.DB), [owner,repo] = identity.repository.split('/'), p = identity.principal
    if (identity.token) {
      const token = await verifyStoredTokenHash(p.id,st)
      if (!token || token.expiresAt <= Date.now() || token.name !== p.name || !(hasScope({...token,id:p.id,name:token.name ?? ''},'repo:read')) || !permitsRepo({...token,id:p.id,name:token.name ?? ''},owner,repo)) { ws.close(1008,'Access expired'); return false }
      ws.serializeAttachment({...ws.deserializeAttachment(),expires:token.expiresAt,principal:{...p,scopes:token.scopes,repos:token.repos}})
    }
    const reads=await d1RepoReads(this.env.DB,owner,repo,p.name || null)
    const pre=prefetched(st,reads,owner,repo,p.name || null)
    const state = reads.states[identity.repository], org = reads.states[owner], access = reads.access.value
    const agent = p.name.includes('/') && !identity.token ? await st.getAgent(p.name) : null
    if (state.deletedAt!==null || org.deletedAt!==null || (p.name.includes('/') && !identity.token && (!agent || agent.revokedAt || agent.suspendedAt))) {ws.close(1008,'Access revoked');return false}
    if (!access || ((privateAcl(access.acl) || access.pending) && (!hasScope(p,'repo:read') || !permitsRepo(p,owner,repo))) || !await mayRead({store:pre,index:async()=>null},owner,repo,p.name || null,access)) { ws.close(1008,'Access changed'); return false }
    return true
    }).catch(() => {
      // A storage outage must fail closed and leave timer scheduling intact.
      ws.close(1011,'Authorization unavailable')
      return false
    })
  }
  async online() {
    const names: string[] = []
    for (const ws of this.sockets()) if (await this.valid(ws)) {
      const {principal} = ws.deserializeAttachment() as SocketIdentity
      if (principal.name) names.push(principal.name)
    }
    return [...new Set(names)].sort()
  }
  private async broadcast(data: unknown) {
    let presence: {participants:Awaited<ReturnType<RepoChannel['participants']>>;acl:RepoAccess['acl']} | undefined
    if ((data as {type:string}).type==='presence' && this.repository) {
      const [owner,repo]=this.repository.split('/')
      const reads=await d1RepoReads(this.env.DB,owner,repo,null)
      if (reads.access.value) presence={participants:await this.participants(this.repository,reads.access.value.acl),acl:reads.access.value.acl}
    }
    const wire = JSON.stringify(presence ? {...data as object,participants:presence.participants} : data)
    for (const ws of this.sockets()) if (await this.valid(ws)) try {
      if (presence) {
        const {principal:p,repository}=ws.deserializeAttachment() as SocketIdentity
        const own=presence.participants.find(row=>row.name===p.name)
        const [owner,repo]=repository.split('/')
        const can_post=!!own && channelPermission(p,owner,repo,presence.acl,own.prefix==='@' || own.prefix==='+')
        ws.send(JSON.stringify({...JSON.parse(wire),can_post}))
      } else ws.send(wire)
    } catch { ws.close() }
  }
  async fetch(request: Request) {
    const identity = JSON.parse(request.headers.get('x-channel-viewer')!) as SocketIdentity
    this.repository=identity.repository
    const after = new URL(request.url).searchParams.get('after') ?? undefined
    const page = this.log.page({after,limit:200})
    const pair = new WebSocketPair(), [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ ...identity, seen:Date.now() })
    // The service just checked this principal against live policy. Reuse that
    // successful check for the first fan-out; never trust a caller's header.
    if (!identity.token && !identity.principal.name.includes('/')) this.authorization.prime(server)
    if (!await this.valid(server)) return new Response('Not found',{status:404})
    server.send(JSON.stringify({ type:'ready', ...page }))
    await this.broadcast({ type:'presence', online:await this.online() })
    await this.schedule(AUTHORIZATION_MS)
    return new Response(null, { status:101, webSocket:client } as ResponseInit)
  }
  async webSocketMessage(ws: WorkerSocket, message: string | ArrayBuffer) {
    if (message !== 'ping') { ws.close(1008,'Post messages through the API'); return }
    const identity = ws.deserializeAttachment() as SocketIdentity
    ws.serializeAttachment({...identity,seen:Date.now()})
    if (await this.valid(ws)) { ws.send(JSON.stringify({type:'presence',online:await this.online()})) }
  }
  async webSocketClose(ws: WorkerSocket) { ws.close(); await this.broadcast({type:'presence',online:await this.online()}) }
  async webSocketError(ws: WorkerSocket) { await this.webSocketClose(ws) }
  async alarm() {
    this.authorization.clear()
    try {
      await this.broadcast({type:'presence',online:await this.online()})
      await this.flushMentions()
    } finally {
      if (this.sockets().length || [...this.log.sql.exec('SELECT id FROM channel_mentions LIMIT 1')].length) await this.schedule(AUTHORIZATION_MS)
    }
  }
}
