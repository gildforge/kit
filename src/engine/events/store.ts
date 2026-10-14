import type { SQL } from '../repo-index-store.js'
import type {
  Emission,
  Hook,
  HookInput,
  HookPatch,
  StreamEvent,
  Delivery,
} from '../api/events-contract.js'
import { ApiError } from '../api/errors.js'
export class EventStore {
  readonly sql: SQL
  constructor(sql: SQL) {
    this.sql = sql
    sql.exec(`
    CREATE TABLE IF NOT EXISTS forge_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,event TEXT,repo TEXT,audience TEXT,payload TEXT,at TEXT);
    CREATE INDEX IF NOT EXISTS forge_events_repo ON forge_events(repo,seq);
    CREATE TABLE IF NOT EXISTS forge_hooks(id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT,config TEXT,events TEXT,active INTEGER,failures INTEGER,reason TEXT,created TEXT,updated TEXT);
    CREATE TABLE IF NOT EXISTS hook_deliveries(delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,hook INTEGER,event_id TEXT,body TEXT,headers TEXT,wire TEXT,result TEXT,attempts INTEGER,state TEXT,queued INTEGER,lease INTEGER,redelivery INTEGER,at TEXT);
    CREATE INDEX IF NOT EXISTS hook_delivery_log ON hook_deliveries(hook,at);
  `)
    const columns = this.rows<{ name: string }>(
      'PRAGMA table_info(forge_hooks)',
    )
    if (!columns.some((c) => c.name === 'creator'))
      sql.exec(
        "ALTER TABLE forge_hooks ADD COLUMN creator TEXT NOT NULL DEFAULT ''",
      )
    const deliveryColumns = this.rows<{ name: string }>(
      'PRAGMA table_info(hook_deliveries)',
    )
    if (!deliveryColumns.some((c) => c.name === 'queued_at'))
      sql.exec(
        'ALTER TABLE hook_deliveries ADD COLUMN queued_at INTEGER NOT NULL DEFAULT 0',
      )
  }
  rows<T extends Record<string, unknown>>(
    q: string,
    ...args: (string | number | null)[]
  ) {
    return [...this.sql.exec<T>(q, ...args)]
  }
  hook(id: number) {
    const h = this.rows<{
      id: number
      creator: string
      scope: string
      config: string
      events: string
      active: number
      failures: number
      reason: string | null
      created: string
      updated: string
    }>('SELECT * FROM forge_hooks WHERE id=?', id)[0]
    return h
      ? {
          ...h,
          config: JSON.parse(h.config) as HookInput['config'],
          events: JSON.parse(h.events) as HookInput['events'],
        }
      : null
  }
  view(id: number, origin: string): Hook {
    const h = this.hook(id)
    if (!h) throw new ApiError(404, 'Hook not found')
    const path = h.scope.startsWith('repo:')
        ? '/repos/' + h.scope.slice(5)
        : '/orgs/' + h.scope.slice(4),
      url = `${origin}/api/v1${path}/hooks/${id}`
    return {
      id,
      name: 'web',
      type: h.scope.startsWith('repo:') ? 'Repository' : 'Organization',
      active: !!h.active,
      events: h.events,
      config: {
        url: h.config.url,
        content_type: h.config.content_type,
        insecure_ssl: '0',
      },
      created_at: h.created,
      updated_at: h.updated,
      url,
      ping_url: url + '/pings',
      deliveries_url: url + '/deliveries',
      disabled_reason: h.reason,
    }
  }
  list(scope: string, origin: string) {
    return this.rows<{ id: number }>(
      'SELECT id FROM forge_hooks WHERE scope=? ORDER BY id',
      scope,
    ).map((h) => this.view(h.id, origin))
  }
  create(scope: string, input: HookInput, origin: string, creator = '') {
    if (
      this.rows<{ n: number }>(
        'SELECT count(*) AS n FROM forge_hooks WHERE scope=?',
        scope,
      )[0].n >= 100
    )
      throw new ApiError(
        422,
        'Maximum 100 hooks per repository or organization',
      )
    const at = new Date().toISOString()
    const id = this.rows<{ id: number }>(
      'INSERT INTO forge_hooks(scope,config,events,active,failures,reason,created,updated,creator) VALUES (?,?,?,?,0,NULL,?,?,?) RETURNING id',
      scope,
      JSON.stringify(input.config),
      JSON.stringify(input.events),
      Number(input.active),
      at,
      at,
      creator,
    )[0].id
    return this.view(id, origin)
  }
  patch(id: number, input: HookPatch, origin: string) {
    const h = this.hook(id)
    if (!h) throw new ApiError(404, 'Hook not found')
    this.sql.exec(
      'UPDATE forge_hooks SET config=?,events=?,active=?,updated=?,failures=?,reason=? WHERE id=?',
      JSON.stringify({ ...h.config, ...input.config }),
      JSON.stringify(input.events ?? h.events),
      Number(input.active ?? !!h.active),
      new Date().toISOString(),
      input.active === true ? 0 : h.failures,
      input.active === true ? null : h.reason,
      id,
    )
    return this.view(id, origin)
  }
  remove(id: number) {
    this.sql.exec('DELETE FROM forge_hooks WHERE id=?', id)
    this.sql.exec('DELETE FROM hook_deliveries WHERE hook=?', id)
  }
  event(id: string) {
    const e = this.rows<{
      seq: number
      id: string
      event: StreamEvent['event']
      repo: string | null
      audience: string | null
      payload: string
      at: string
    }>('SELECT * FROM forge_events WHERE id=?', id)[0]
    return e
      ? {
          id: e.id,
          cursor: String(e.seq),
          event: e.event,
          repository: e.repo,
          payload: JSON.parse(e.payload) as Emission['payload'],
          created_at: e.at,
          audience: e.audience,
        }
      : null
  }
  append(e: Emission) {
    this.sql.exec(
      'INSERT OR IGNORE INTO forge_events(id,event,repo,audience,payload,at) VALUES (?,?,?,?,?,?)',
      e.id,
      e.event,
      e.repository,
      e.audience ?? null,
      JSON.stringify(e.payload),
      new Date().toISOString(),
    )
    return this.event(e.id)!
  }
  sequence() {
    return this.rows<{ seq: number }>(
      'SELECT coalesce(max(seq),0) AS seq FROM forge_events',
    )[0].seq
  }
  read(
    repos: string[],
    since: number,
    viewer: string,
    limit = 100,
    audiences: string[] = [],
    mentions: { viewer: string; raw: string[] } = { viewer: '', raw: [] },
  ) {
    const events: StreamEvent[] = [],
      rows = this.rows<{
        id: string
        seq: number
        event: string
        repo: string | null
        audience: string | null
      }>(
        'SELECT id,seq,event,repo,audience FROM forge_events WHERE seq>? ORDER BY seq LIMIT 1000',
        since,
      )
    let cursor = since
    for (const row of rows) {
      cursor = row.seq
      // channel.mention is repo-scoped: its agent reads its own with a
      // repo-restricted token, and an orchestrator reads every agent's (raw view).
      const mention =
        row.event === 'channel.mention' &&
        !!row.repo &&
        ((!!mentions.viewer && row.audience === mentions.viewer) ||
          mentions.raw.includes(row.repo))
      if (
        row.audience &&
        row.audience !== viewer &&
        !audiences.includes(row.audience) &&
        !mention
      )
        continue
      if (row.repo && !repos.includes(row.repo)) continue
      if (!row.repo && !row.audience) continue
      const { audience, ...event } = this.event(row.id)!
      events.push(event)
      if (events.length >= limit) break
    }
    return { events, cursor: String(cursor) }
  }
  enqueue(hook: number, event: Emission, redelivery = false) {
    const id = crypto.randomUUID(),
      at = new Date().toISOString()
    this.sql.exec(
      'INSERT INTO hook_deliveries(id,hook,event_id,body,attempts,state,queued,lease,redelivery,at) VALUES (?,?,?,?,0,?,0,0,?,?)',
      id,
      hook,
      event.id,
      JSON.stringify(event.payload),
      'pending',
      Number(redelivery),
      at,
    )
    return id
  }
  delivery(id: string) {
    const row = this.rows<{
      id: string
      delivery_id: number
      hook: number
      event_id: string
      body: string
      headers: string | null
      wire: string | null
      result: string | null
      attempts: number
      state: string
      lease: number
      queued: number
      redelivery: number
      at: string
    }>('SELECT * FROM hook_deliveries WHERE id=?', id)[0]
    return row ?? null
  }
  deliveryGuid(id: number) {
    return (
      this.rows<{ id: string }>(
        'SELECT id FROM hook_deliveries WHERE delivery_id=?',
        id,
      )[0]?.id ?? null
    )
  }
  viewDelivery(id: string): Delivery {
    const row = this.delivery(id)
    if (!row) throw new ApiError(404, 'Delivery not found')
    const event = this.event(row.event_id)!,
      r = row.result
        ? (JSON.parse(row.result) as {
            status: number | null
            headers: Record<string, string>
            body: string
            duration: number
            truncated: boolean
            error: string | null
            at: string
          })
        : null
    return {
      id: row.delivery_id,
      guid: row.id,
      delivered_at: r?.at ?? null,
      redelivery: !!row.redelivery,
      duration: r?.duration ?? 0,
      status: row.state,
      status_code: r?.status ?? null,
      event: event.event,
      action:
        typeof event.payload.action === 'string' ? event.payload.action : null,
      attempts: row.attempts,
      request: {
        headers: row.headers ? JSON.parse(row.headers) : {},
        payload: JSON.parse(row.body),
        wire: row.wire ?? row.body,
      },
      response: {
        headers: r?.headers ?? {},
        payload: r?.body ?? '',
        truncated: r?.truncated ?? false,
      },
      error: r?.error ?? null,
    }
  }
  deliveries(hook: number) {
    return this.rows<{ id: string }>(
      'SELECT id FROM hook_deliveries WHERE hook=? ORDER BY at DESC,id DESC LIMIT 100',
      hook,
    ).map((r) => this.viewDelivery(r.id))
  }
  trim(hook: number) {
    this.sql.exec(
      "DELETE FROM hook_deliveries WHERE hook=? AND state IN ('success','failed','disabled') AND id NOT IN (SELECT id FROM hook_deliveries WHERE hook=? ORDER BY at DESC,id DESC LIMIT 100)",
      hook,
      hook,
    )
  }
}
