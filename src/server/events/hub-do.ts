import { channelFrom, type ChannelBindings } from '../channel/binding.js'
import { systemNote } from '../../engine/channel/system.js'
import { d1Settings } from '../settings-store.js'
import { mayRead, mayContribute } from '../repo-read.js'
import { d1Store } from '../drivers/d1.js'
import { orchestratedRepos } from '../orchestrators.js'
import type { D1Database } from '@cloudflare/workers-types'
import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectState, Queue } from '@cloudflare/workers-types'
import { EventStore } from '../../engine/events/store.js'
import type { SQL } from '../../engine/repo-index-store.js'
import type { Emission, HookInput, HookPatch } from '../../engine/api/events-contract.js'
import { hookInput, hookPatch, eventName } from '../../engine/api/events-contract.js'
import { hookURL, signature, retryDelay } from '../../engine/events/security.js'
import { deliverHTTP, resolvePublic } from './transport.js'
import { connect } from 'cloudflare:sockets'
import { ApiError } from '../../engine/api/errors.js'
export interface EventEnv extends ChannelBindings {
  DB: D1Database
  REPO_INDEX: {idFromName(name: string): unknown; get(id: unknown): {metaFile(path: string): Promise<string|null>; status(): Promise<{ready: boolean}>}}
  WEBHOOKS?: Queue<{ delivery: string }>
}
export class ForgeEvents extends DurableObject<EventEnv> {
  protected events: EventStore
  private waiters = new Set<() => void>()
  constructor(ctx: DurableObjectState, env: EventEnv) {
    super(ctx as never, env)
    this.events = new EventStore(ctx.storage.sql as unknown as SQL)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS channel_outbox(id TEXT PRIMARY KEY,json TEXT NOT NULL)')
  }
  async blocked(key: string) {
    if (!this.env.DB) return false
    const st = d1Settings(this.env.DB),
      canonical = await st.canonical(key),
      item = await st.state(canonical),
      org = await st.state(canonical.split('/')[0])
    return (
      item.archived ||
      item.deletedAt !== null ||
      item.moving ||
      org.archived ||
      org.deletedAt !== null ||
      org.moving
    )
  }
  renameScope(from: string, to: string) {
    this.ctx.storage.transactionSync(() => {
      for (const row of this.events.rows<{ id: number; scope: string }>(
        'SELECT id,scope FROM forge_hooks',
      )) {
        const key = row.scope.slice(row.scope.indexOf(':') + 1)
        if (key === from || key.startsWith(from + '/'))
          this.events.sql.exec(
            'UPDATE forge_hooks SET scope=? WHERE id=?',
            row.scope.split(':')[0] + ':' + to + key.slice(from.length),
            row.id,
          )
      }
      for (const row of this.events.rows<{
        seq: number
        repo: string
        audience: string
      }>('SELECT seq,repo,audience FROM forge_events')) {
        if (row.repo === from || row.repo?.startsWith(from + '/'))
          this.events.sql.exec(
            'UPDATE forge_events SET repo=? WHERE seq=?',
            to + row.repo.slice(from.length),
            row.seq,
          )
        if (row.audience === from)
          this.events.sql.exec(
            'UPDATE forge_events SET audience=? WHERE seq=?',
            to,
            row.seq,
          )
      }
    })
  }
  purgeScope(key: string) {
    this.ctx.storage.transactionSync(() => {
      for (const row of this.events.rows<{ id: number; scope: string }>(
        'SELECT id,scope FROM forge_hooks',
      )) {
        const k = row.scope.slice(row.scope.indexOf(':') + 1)
        if (k === key || k.startsWith(key + '/')) {
          this.events.sql.exec(
            'DELETE FROM hook_deliveries WHERE hook=?',
            row.id,
          )
          this.events.remove(row.id)
        }
      }
      this.events.sql.exec(
        'DELETE FROM forge_events WHERE repo=? OR repo LIKE ? OR audience=?',
        key,
        key + '/%',
        key,
      )
    })
  }
  list(scope: string, origin: string) {
    return this.events.list(scope, origin)
  }
  check(scope: string, id: number) {
    if (this.events.hook(id)?.scope !== scope)
      throw new ApiError(404, 'Hook not found')
  }
  get(scope: string, id: number, origin: string) {
    this.check(scope, id)
    return this.events.view(id, origin)
  }
  async create(scope: string, input: HookInput, origin: string, creator: string) {
    const parsed = hookInput.parse(input)
    hookURL(parsed.config.url)
    const h = this.events.create(scope, parsed, origin, creator)
    await this.ping(scope, h.id, origin)
    return h
  }
  patch(scope: string, id: number, input: HookPatch, origin: string) {
    this.check(scope, id)
    const parsed = hookPatch.parse(input)
    if (parsed.config?.url) hookURL(parsed.config.url)
    return this.events.patch(id, parsed, origin)
  }
  remove(scope: string, id: number) {
    this.check(scope, id)
    this.events.remove(id)
    return { ok: true }
  }
  deliveries(scope: string, id: number) {
    this.check(scope, id)
    return this.events.deliveries(id)
  }
  delivery(scope: string, id: number, delivery: number) {
    this.check(scope, id)
    const guid = this.events.deliveryGuid(delivery)
    if (!guid || this.events.delivery(guid)?.hook !== id)
      throw new ApiError(404, 'Delivery not found')
    return this.events.viewDelivery(guid)
  }
  async redeliver(scope: string, id: number, delivery: number) {
    const original = this.delivery(scope, id, delivery)
    const previous = this.events.delivery(original.guid)!,
      event = this.events.event(previous.event_id)!
    const queued = this.events.enqueue(
      id,
      {
        id: event.id,
        event: event.event,
        repository: event.repository,
        payload: event.payload,
      },
      true,
    )
    await this.ctx.storage.setAlarm(Date.now() + 1)
    const receipt = this.events.viewDelivery(queued)
    return { id: receipt.id, guid: receipt.guid }
  }
  async ping(scope: string, id: number, origin: string) {
    this.check(scope, id)
    const event: Emission = {
      id: crypto.randomUUID(),
      event: 'ping',
      repository: scope.startsWith('repo:') ? scope.slice(5) : null,
      audience: scope.startsWith('org:') ? scope.slice(4) : undefined,
      payload: {
        zen: 'Keep your harness. Share your work.',
        hook_id: id,
        hook: this.events.view(id, origin),
      },
    }
    this.events.append(event)
    const delivery = this.events.enqueue(id, event)
    await this.ctx.storage.setAlarm(Date.now() + 1)
    this.wake()
    const receipt = this.events.viewDelivery(delivery)
    return { id: receipt.id, guid: receipt.guid }
  }
  private wake() {
    for (const wake of this.waiters) wake()
    this.waiters.clear()
  }
  async emit(event: Emission) {
    if (await this.blocked(event.repository ?? event.audience ?? ''))
      return { accepted: false }
    eventName.parse(event.event)
    if (!event.id || JSON.stringify(event.payload).length > 1024 * 1024)
      throw new ApiError(422, 'Invalid or oversized event')
    this.ctx.storage.transactionSync(() => {
      if (this.events.event(event.id)) return
      const stored = this.events.append(event)
      event = { ...event, created_at: stored.created_at }
      // Session updates have no channel line but still drive the roster state.
      if (systemNote(event) || event.event === 'push' || event.event === 'session') this.events.sql.exec('INSERT OR IGNORE INTO channel_outbox VALUES (?,?)',event.id,JSON.stringify(event))
      const scope = event.repository ? `repo:${event.repository}` : null,
        owner = event.repository?.split('/')[0] ?? event.audience
      const hooks = this.events.rows<{ id: number; events: string }>(
        'SELECT id,events FROM forge_hooks WHERE active=1 AND (scope=? OR scope=?)',
        scope,
        `org:${owner}`,
      )
      for (const h of hooks)
        if ((JSON.parse(h.events) as string[]).includes(event.event))
          this.events.enqueue(h.id, event)
    })
    this.wake()
    await this.ctx.storage.setAlarm(Date.now() + 1)
    return this.events.event(event.id)!.cursor
  }
  sequence() {
    return String(this.events.sequence())
  }
  private async readable(repos:string[],viewer:string) {
    const store=d1Store(this.env.DB)
    return (await Promise.all(repos.map(async repository=>{
      const [owner,repo]=repository.split('/')
      // A repository's events (channel, sessions, Actions) are its contributors' only.
      return await mayContribute({store,index:async()=>null},owner,repo,viewer)?repository:null
    }))).filter((r):r is string=>r!==null)
  }
  async read(
    repos: string[],
    since: string,
    viewer: string,
    wait = 20000,
    ownerEvents = true,
  ) {
    if (
      !/^(0|[1-9][0-9]{0,15})$/.test(since) ||
      Number(since) > this.events.sequence()
    )
      throw new ApiError(422, 'Invalid event cursor')
    const audiences = async () =>
      !ownerEvents || viewer.includes('/')
        ? []
        : (await d1Store(this.env.DB).orgsFor(viewer))
            .filter((o) => o.role === 'owner' || o.role === 'admin')
            .map((o) => o.name)
    const readable = await this.readable(repos,viewer)
    const mentions = {viewer, raw: await orchestratedRepos(d1Store(this.env.DB), viewer, readable)}
    let result = this.events.read(
      readable,
      Number(since),
      ownerEvents ? viewer : '',
      100,
      await audiences(),
      mentions,
    )
    if (!result.events.length && result.cursor === since && wait) {
      await new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timer)
            this.waiters.delete(done)
            resolve()
          },
          timer = setTimeout(done, Math.min(20000, wait))
        this.waiters.add(done)
      })
      // Access is checked again after the wait.
      const again = await this.readable(repos,viewer)
      result = this.events.read(
        again,
        Number(since),
        ownerEvents ? viewer : '',
        100,
        await audiences(),
        {viewer, raw: await orchestratedRepos(d1Store(this.env.DB), viewer, again)},
      )
    }
    return result
  }
  protected async flushChannel() {
    if (!this.env.REPO_CHANNEL) return
    for (const row of this.events.rows<{id:string;json:string}>('SELECT id,json FROM channel_outbox LIMIT 100')) {
      const event = JSON.parse(row.json) as Emission
      const state = await d1Settings(this.env.DB).state(event.repository!)
      await channelFrom(this.env,state.id).system({...event,created_at:this.events.event(event.id)!.created_at})
      this.events.sql.exec('DELETE FROM channel_outbox WHERE id=?',row.id)
    }
  }
  async alarm() {
    try { await this.flushChannel() } catch { await this.ctx.storage.setAlarm(Date.now()+30000) }

    if (!this.env.WEBHOOKS) throw Error('WEBHOOKS binding is required')
    // A lost queue acknowledgement or consumer crash must not strand queued rows.
    this.events.sql.exec("UPDATE hook_deliveries SET queued=0,state='pending',lease=0 WHERE state IN ('pending','sending') AND queued=1 AND queued_at<? AND lease<=?", Date.now() - 3600000, Date.now())
    const pending = this.events.rows<{ id: string }>(
      "SELECT id FROM hook_deliveries WHERE state='pending' AND queued=0 LIMIT 100",
    )
    for (const row of pending) {
      await this.env.WEBHOOKS.send({ delivery: row.id })
      this.events.sql.exec('UPDATE hook_deliveries SET queued=1,queued_at=? WHERE id=?', Date.now(), row.id)
    }
    const remaining = this.events.rows<{n: number}>("SELECT count(*) n FROM hook_deliveries WHERE state IN ('pending','sending')")[0].n
    if (remaining || this.events.rows('SELECT id FROM channel_outbox LIMIT 1').length && this.env.REPO_CHANNEL) await this.ctx.storage.setAlarm(Date.now() + (pending.length === 100 ? 250 : 60000))
  }
  async creatorAccess(hook: NonNullable<ReturnType<EventStore['hook']>>, repository: string | null) {
    if (!hook.creator) return false // Existing unowned hooks require recreation.
    const store = d1Store(this.env.DB)
    if (hook.scope.startsWith('org:')) {
      if (!['owner','admin'].includes((await store.orgRole(hook.scope.slice(4), hook.creator)) ?? '')) return false
      if(repository && repository.split('/')[0]!==hook.scope.slice(4))return false
    } else {
      const owner = hook.scope.slice(5).split('/')[0]
      if (hook.creator !== owner && !['owner','admin'].includes((await store.orgRole(owner, hook.creator)) ?? '')) return false
    }
    if (!repository) return true
    if(hook.scope.startsWith('repo:') && repository!==hook.scope.slice(5))return false
    const [owner, repo] = repository.split('/')
    return mayRead({store, index: async (o, r) => {
      const state=await store.settings.state(`${o}/${r}`)
      const index = this.env.REPO_INDEX.get(this.env.REPO_INDEX.idFromName(state.id))
      return (await index.status()).ready ? index : null
    }}, owner, repo, hook.creator)
  }
  deadLetter(id: string) {
    const row = this.events.delivery(id)
    if (!row || ['success','failed','disabled'].includes(row.state)) return
    this.events.sql.exec("UPDATE hook_deliveries SET state='failed',lease=0,result=? WHERE id=?", JSON.stringify({status:null,headers:{},body:'',truncated:false,error:'Queue retries exhausted (dead letter)',at:new Date().toISOString(),duration:0}), id)
  }
  protected send(url: string, headers: Record<string, string>, body: string) {
    return deliverHTTP(url, headers, body, {connect, resolve: resolvePublic})
  }
  async attempt(id: string) {
    const row = this.events.delivery(id)
    if (!row || ['success', 'failed', 'disabled'].includes(row.state))
      return { retry: false, delaySeconds: 0 }
    const hook = this.events.hook(row.hook)
    if (!hook || (!hook.active && !row.redelivery)) {
      this.events.sql.exec(
        "UPDATE hook_deliveries SET state='disabled' WHERE id=?",
        id,
      )
      return { retry: false, delaySeconds: 0 }
    }
    if (await this.blocked(hook.scope.slice(hook.scope.indexOf(':') + 1))) {
      this.events.sql.exec(
        "UPDATE hook_deliveries SET state='disabled' WHERE id=?",
        id,
      )
      return { retry: false, delaySeconds: 0 }
    }
    const source = this.events.event(row.event_id)!
    if (!await this.creatorAccess(hook, source.repository)) {
      this.events.sql.exec("UPDATE forge_hooks SET active=0,reason=? WHERE id=?", 'Hook creator no longer has repository/organization access; recreate after access is restored.', hook.id)
      this.events.sql.exec("UPDATE hook_deliveries SET state='disabled',lease=0 WHERE id=?", id)
      return { retry: false, delaySeconds: 0 }
    }
    // Access checks await RPCs: another attempt may have acquired the lease.
    const currentRow = this.events.delivery(id)!
    if (['success','failed','disabled'].includes(currentRow.state)) return {retry: false, delaySeconds: 0}
    if (currentRow.lease > Date.now()) return { retry: false, defer: true, delaySeconds: 15 }
    const attempt = currentRow.attempts + 1,
      start = performance.now(),
      event = this.events.event(row.event_id)!
    this.events.sql.exec(
      "UPDATE hook_deliveries SET state='sending',lease=?,attempts=? WHERE id=?",
      Date.now() + 15000,
      attempt,
      id,
    )
    const body =
        hook.config.content_type === 'form'
          ? new URLSearchParams({ payload: row.body }).toString()
          : row.body,
      timestamp = String(Math.floor(Date.now() / 1000)),
      hmac = await signature(hook.config.secret, timestamp + '.' + body),
      headers = {
        'content-type':
          hook.config.content_type === 'form'
            ? 'application/x-www-form-urlencoded'
            : 'application/json',
        'user-agent': 'gild-webhooks/1',
        'x-gild-event': event.event,
        'x-gild-timestamp': timestamp,
        'x-gild-delivery': id,
        'x-hub-signature-256': hmac,
        'x-gild-signature-256': hmac,
      }
    this.events.sql.exec(
      'UPDATE hook_deliveries SET wire=?,headers=? WHERE id=?',
      body,
      JSON.stringify(headers),
      id,
    )
    let result: {
      status: number | null
      headers: Record<string, string>
      body: string
      truncated: boolean
      error: string | null
      at: string
      duration: number
    }
    try {
      result = {
        ...(await this.send(hook.config.url, headers, body)),
        error: null,
        at: new Date().toISOString(),
        duration: (performance.now() - start) / 1000,
      }
    } catch (e) {
      result = {
        status: null,
        headers: {},
        body: '',
        truncated: false,
        error: (e as Error).message.slice(0, 1000),
        at: new Date().toISOString(),
        duration: (performance.now() - start) / 1000,
      }
    }
    const success =
      result.status !== null && result.status >= 200 && result.status < 300
    let disabled = false,
      wasActive = false
    this.ctx.storage.transactionSync(() => {
      const current = this.events.hook(hook.id),
        failures = success ? 0 : (current?.failures ?? hook.failures) + 1
      disabled = failures >= 10
      wasActive = !!current?.active
      this.events.sql.exec(
        'UPDATE hook_deliveries SET result=?,state=?,lease=0 WHERE id=?',
        JSON.stringify(result),
        success ? 'success' : disabled || attempt >= 8 ? 'failed' : 'pending',
        id,
      )
      if (current)
        this.events.sql.exec(
          'UPDATE forge_hooks SET failures=?,active=?,reason=?,updated=? WHERE id=?',
          failures,
          disabled ? 0 : current.active,
          disabled
            ? 'Disabled after 10 consecutive failed attempts; fix the receiver and re-enable this hook.'
            : current.reason,
          new Date().toISOString(),
          hook.id,
        )
      this.events.trim(hook.id)
    })
    if (disabled && wasActive)
      await this.emit({
        id: `disabled:${hook.id}:${id}`,
        event: 'webhook_disabled',
        repository: hook.scope.startsWith('repo:') ? hook.scope.slice(5) : null,
        audience: hook.scope.startsWith('org:')
          ? hook.scope.slice(4)
          : undefined,
        payload: {
          hook_id: hook.id,
          message: 'Webhook disabled after 10 consecutive failures',
        },
      })

    return {
      retry: !success && !disabled && attempt < 8,
      delaySeconds: retryDelay(attempt),
    }
  }
}
