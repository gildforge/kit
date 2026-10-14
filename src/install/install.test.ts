import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { install } from '../../dist/install/index.js'

// A Cloudflare account in memory, answering the API calls the installer makes.
function account() {
  const state = {
    subdomain: 'acme',
    databases: [] as { uuid: string; name: string; sql: string[]; ledger?: string[] }[],
    buckets: new Set<string>(),
    queues: [] as { queue_id: string; queue_name: string; consumers: { consumer_id: string; script_name: string; body: unknown }[] }[],
    scripts: [] as { id: string; migration_tag?: string; metadata: any }[],
    tokens: [] as { name: string; permissions: string[] }[],
    schedules: [] as unknown[],
    rows: { claims: [] as unknown[][], tokens: [] as unknown[][] },
  }
  let n = 0
  const id = () => `id${++n}`
  const ok = (result: unknown, status = 200) => new Response(JSON.stringify({ success: true, result, errors: [] }), { status })
  const missing = () => new Response(JSON.stringify({ success: false, result: null, errors: [{ code: 10006, message: 'not found' }] }), { status: 404 })
  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input), path = url.pathname.replace('/client/v4/accounts/acct', ''), method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    if (url.hostname.endsWith('.workers.dev')) return new Response('{}', { status: 200 })
    if (path === '' ) return ok({ id: 'acct', name: 'Acme' })
    if (path === '/workers/subdomain') return ok({ subdomain: state.subdomain })
    if (path === '/d1/database' && method === 'GET') return ok(state.databases.filter(d => d.name === url.searchParams.get('name')))
    if (path === '/d1/database' && method === 'POST') { const d = { uuid: id(), name: body.name, sql: [] }; state.databases.push(d); return ok(d) }
    const q = path.match(/^\/d1\/database\/(\w+)\/query$/)
    if (q) {
      const db = state.databases.find(d => d.uuid === q[1])!
      const sql: string = body.sql
      if (/^SELECT resource FROM gild_install/.test(sql)) {
        if (!db.ledger) return new Response(JSON.stringify({ success: false, result: null, errors: [{ code: 7500, message: 'no such table: gild_install: SQLITE_ERROR' }] }), { status: 400 })
        return ok([{ results: db.ledger.map(resource => ({ resource })) }])
      }
      if (/^CREATE TABLE IF NOT EXISTS gild_install/.test(sql)) { db.ledger ??= []; return ok([{ results: [] }]) }
      if (/^INSERT OR IGNORE INTO gild_install/.test(sql)) { if (!db.ledger!.includes(body.params[0])) db.ledger!.push(body.params[0]); return ok([{ results: [] }]) }
      if (/^SELECT name FROM d1_migrations/.test(sql)) return ok([{ results: db.sql.filter(s => s.startsWith('applied:')).map(s => ({ name: s.slice(8) })) }])
      if (/^SELECT name, public_key FROM claims/.test(sql)) return ok([{ results: state.rows.claims.filter(r => r[0] === body.params[0]).map(r => ({ name: r[0], public_key: r[1] })) }])
      if (/^INSERT INTO claims/.test(sql)) state.rows.claims.push(body.params)
      if (/^INSERT INTO api_tokens/.test(sql)) state.rows.tokens.push(body.params)
      for (const m of sql.matchAll(/INSERT INTO d1_migrations\(name\) VALUES \('([^']+)'\)/g)) db.sql.push('applied:' + m[1])
      return ok([{ results: [] }])
    }
    const bucket = path.match(/^\/r2\/buckets\/(.+)$/)
    if (bucket) return state.buckets.has(bucket[1]) ? ok({ name: bucket[1] }) : missing()
    if (path === '/r2/buckets') { state.buckets.add(body.name); return ok({}) }
    if (path === '/queues' && method === 'GET') return new Response(JSON.stringify({ success: true, result: state.queues, result_info: { page: 1, total_pages: 1 } }))
    if (path === '/queues' && method === 'POST') { const queue = { queue_id: id(), queue_name: body.queue_name, consumers: [] }; state.queues.push(queue); return ok(queue) }
    const consumers = path.match(/^\/queues\/(\w+)\/consumers(?:\/(\w+))?$/)
    if (consumers) {
      const queue = state.queues.find(x => x.queue_id === consumers[1])!
      if (method === 'GET') return ok(queue.consumers.map(c => ({ consumer_id: c.consumer_id, script: c.script_name })))
      if (method === 'POST') { queue.consumers.push({ consumer_id: id(), script_name: body.script_name, body }); return ok({}) }
      const c = queue.consumers.find(x => x.consumer_id === consumers[2])!
      c.body = body
      return ok({})
    }
    if (path === '/workers/scripts' && method === 'GET') return ok(state.scripts.map(s => ({ id: s.id, migration_tag: s.migration_tag })))
    const script = path.match(/^\/workers\/scripts\/([\w-]+)(\/subdomain|\/schedules)?$/)
    if (script && script[2] === '/schedules') { state.schedules = body; return ok({}) }
    if (script && script[2] === '/subdomain') return ok({})
    if (script) {
      const metadata = JSON.parse(await (body as FormData).get('metadata')!.text())
      const existing = state.scripts.find(s => s.id === script[1])
      const tag = metadata.migrations?.new_tag ?? existing?.migration_tag
      if (existing) Object.assign(existing, { metadata, migration_tag: tag })
      else state.scripts.push({ id: script[1], metadata, migration_tag: tag })
      return ok({})
    }
    if (path === '/tokens/permission_groups') return ok(['Artifacts Read', 'Artifacts Write', 'Queues Write', 'D1 Write'].map(name => ({ id: `pg-${name}`, name })))
    if (path === '/tokens' && method === 'POST') { state.tokens.push({ name: body.name, permissions: body.policies[0].permission_groups.map((g: { id: string }) => g.id) }); return ok({ value: 'worker-token' }) }
    throw new Error(`unexpected ${method} ${path}`)
  }
  return { state, fetch }
}

const manifest = JSON.parse(readFileSync(new URL('../../template/worker/manifest.json', import.meta.url), 'utf8'))
const template = { manifest, read: async (path: string) => path.endsWith('.sql') ? 'CREATE TABLE x(a);' : new Uint8Array([0]) }
const owner = { name: 'acme', email: 'a@acme.dev', publicKey: 'ssh-ed25519 AAAAC3Nza acme@laptop' }

test('a first install creates everything once and a second only upgrades', async () => {
  const cf = account()
  const options = { token: 'user-token', accountId: 'acct', owner, template, fetch: cf.fetch as typeof fetch }
  const first = await install(options)
  assert.equal(first.url, 'https://gild.acme.workers.dev')
  assert.match(first.token, /^gf_[0-9a-f]{32}$/)
  assert.equal(cf.state.databases.length, 2)
  assert.equal(cf.state.queues.length, 3)
  assert.deepEqual([...cf.state.buckets], ['gild-fragments'])
  const migrations = manifest.d1_databases.reduce((n: number, d: { migrations: string[] }) => n + d.migrations.length, 0)
  assert.equal(cf.state.databases.flatMap(d => d.sql).length, migrations)

  const worker = cf.state.scripts[0].metadata
  const secrets = worker.bindings.filter((b: { type: string }) => b.type === 'secret_text')
  assert.deepEqual(secrets.map((b: { name: string }) => b.name).sort(), ['ACTIONS_SECRET_KEY', 'ARTIFACTS_TOKEN', 'EVENTS_TOKEN', 'SESSION_SECRET'])
  // The Worker gets its own narrow token, never the installer's.
  assert.equal(secrets.find((b: { name: string }) => b.name === 'ARTIFACTS_TOKEN').text, 'worker-token')
  assert.deepEqual(cf.state.tokens[0].permissions, ['pg-Artifacts Read', 'pg-Artifacts Write', 'pg-Queues Write'])
  assert.equal(worker.bindings.find((b: { name: string }) => b.name === 'CLOUDFLARE_ACCOUNT_ID').text, 'acct')
  assert.equal(worker.migrations.new_tag, 'gild-v1')
  assert.equal(cf.state.rows.claims.length, 1)

  const second = await install(options)
  assert.equal(second.url, first.url)
  assert.equal(cf.state.databases.length, 2)
  assert.equal(cf.state.queues.length, 3)
  assert.equal(cf.state.databases.flatMap(d => d.sql).length, migrations, 'migrations apply once')
  const upgrade = cf.state.scripts[0].metadata
  assert.deepEqual(upgrade.keep_bindings, ['secret_text'])
  assert.equal(upgrade.bindings.some((b: { type: string }) => b.type === 'secret_text'), false, 'secrets are kept, not replaced')
  assert.equal(upgrade.migrations, undefined, 'Durable Object classes are not created twice')
  assert.equal(cf.state.tokens.length, 1)
  for (const q of cf.state.queues.filter(q => q.consumers.length)) assert.equal(q.consumers.length, 1, `${q.queue_name} has one consumer`)
  assert.equal(cf.state.rows.claims.length, 1, 'the owner is claimed once')
  assert.equal(cf.state.rows.tokens.length, 2, 'each run hands the desktop a token')
})

test('an install names every resource after its Worker', async () => {
  const cf = account()
  await install({ token: 't', accountId: 'acct', owner, template, fetch: cf.fetch as typeof fetch, name: 'forge' })
  assert.deepEqual(cf.state.databases.map(d => d.name).sort(), ['forge', 'forge-search'])
  assert.deepEqual(cf.state.queues.map(q => q.queue_name).sort(), ['forge-artifacts-events', 'forge-webhooks', 'forge-webhooks-dead'])
  assert.deepEqual([...cf.state.buckets], ['forge-fragments'])
  assert.equal(cf.state.scripts[0].id, 'forge')
})

test('a name another key owns is refused', async () => {
  const cf = account()
  await install({ token: 't', accountId: 'acct', owner, template, fetch: cf.fetch as typeof fetch })
  await assert.rejects(install({ token: 't', accountId: 'acct', owner: { ...owner, publicKey: 'ssh-ed25519 BBBB other' }, template, fetch: cf.fetch as typeof fetch }), /different key/)
})

test('an account with another deployment\'s resources is refused before anything is made', async () => {
  const cf = account()
  // gild.gg's own resources, in the account it deploys from.
  cf.state.databases.push({ uuid: 'prod-search', name: 'gild-search', sql: [] })
  cf.state.buckets.add('gild-fragments')
  cf.state.queues.push({ queue_id: 'prod-webhooks', queue_name: 'gild-webhooks', consumers: [{ consumer_id: 'c', script_name: 'gild-site', body: {} }] })
  await assert.rejects(install({ token: 't', accountId: 'acct', owner, template, fetch: cf.fetch as typeof fetch }),
    /D1 database "gild-search", R2 bucket "gild-fragments", queue "gild-webhooks"/)
  assert.equal(cf.state.databases.length, 1, 'no database was created')
  assert.equal(cf.state.queues.length, 1, 'no queue was created')
  assert.equal(cf.state.scripts.length, 0, 'no Worker was uploaded')
  assert.deepEqual(cf.state.databases[0].sql, [], 'nothing ran against the other deployment')
  // Under its own name the install goes ahead beside them.
  const ok = await install({ token: 't', accountId: 'acct', owner, template, fetch: cf.fetch as typeof fetch, name: 'mine' })
  assert.equal(ok.url, 'https://mine.acme.workers.dev')
  assert.equal(cf.state.queues.find(q => q.queue_name === 'gild-webhooks')!.consumers.length, 1)
})

test('a database of the same name that no install made is refused', async () => {
  const cf = account()
  cf.state.databases.push({ uuid: 'other', name: 'gild', sql: [] })
  await assert.rejects(install({ token: 't', accountId: 'acct', owner, template, fetch: cf.fetch as typeof fetch }), /D1 database "gild"/)
  assert.equal(cf.state.scripts.length, 0)
})
