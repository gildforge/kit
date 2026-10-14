// Install gild into a Cloudflare account with one API token: the databases,
// bucket and queues, the kit's prebuilt Worker, its migrations and secrets,
// and the owner. Every step looks before it creates, so running it again
// upgrades an install in place and keeps its data and secrets.
//
// The Worker and its bindings come from template/wrangler.jsonc by way of
// template/worker/manifest.json (scripts/bundle.mjs), so `wrangler deploy`
// and this installer read one description of the Worker.
import { Cloudflare, CloudflareError, type Fetch } from './cloudflare.js'

export { Cloudflare, CloudflareError, type Fetch }

export interface Manifest {
  name: string
  main: string
  modules: { name: string; type: 'esm' | 'wasm' }[]
  compatibility_date: string
  compatibility_flags: string[]
  limits?: { cpu_ms?: number }
  vars: Record<string, string>
  r2_buckets: { binding: string; bucket_name: string }[]
  d1_databases: { binding: string; database_name: string; migrations: string[]; migrations_dir: string }[]
  durable_objects: { name: string; class_name: string }[]
  migrations: { tag: string; new_sqlite_classes?: string[] }[]
  queues: {
    producers: { binding: string; queue: string }[]
    consumers: { queue: string; max_batch_size?: number; max_batch_timeout?: number; max_retries?: number; dead_letter_queue?: string }[]
  }
  crons: string[]
}

/** The template's files: template/worker/* and the migrations dirs. */
export interface Template {
  manifest: Manifest
  read(path: string): Promise<Uint8Array | string>
}

export interface Owner {
  /** The owner's gild name, e.g. "sami". */
  name: string
  email: string
  /** OpenSSH public key line ("ssh-ed25519 AAAA…"); signs git and CLI sign-in. */
  publicKey: string
}

export type StepId = 'account' | 'subdomain' | 'databases' | 'bucket' | 'queues' | 'migrations' | 'worker' | 'consumers' | 'owner' | 'ready'
export const STEPS: { id: StepId; label: string }[] = [
  { id: 'account', label: 'Check the API token' },
  { id: 'subdomain', label: 'Find your workers.dev subdomain' },
  { id: 'databases', label: 'Create the databases' },
  { id: 'bucket', label: 'Create the storage bucket' },
  { id: 'queues', label: 'Create the queues' },
  { id: 'migrations', label: 'Apply database migrations' },
  { id: 'worker', label: 'Upload the gild Worker' },
  { id: 'consumers', label: 'Connect queues and the schedule' },
  { id: 'owner', label: 'Make you the owner' },
  { id: 'ready', label: 'Wait for the instance to answer' },
]

export interface Progress { step: StepId; state: 'running' | 'done'; detail?: string }

export interface InstallOptions {
  token: string
  accountId: string
  owner: Owner
  template: Template
  fetch: Fetch
  /** The Worker's name and the prefix of every resource; one install per name. */
  name?: string
  onProgress?(progress: Progress): void
  /** Random bytes, injectable for tests. */
  random?(length: number): Uint8Array
}

export interface Installed {
  accountId: string
  name: string
  url: string
  /** The owner's API token (gf_…): the desktop keeps it, the instance keeps its hash. */
  token: string
}

export interface Account { id: string; name: string }

/** The accounts this token reaches, for the desktop's picker. */
export async function accounts(token: string, fetch: Fetch): Promise<Account[]> {
  const cf = new Cloudflare(token, fetch)
  return (await cf.all<Account>('/accounts')).map(a => ({ id: a.id, name: a.name }))
}

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`
/** Template names start "gild"; an install named otherwise renames each resource alike. */
const rename = (resource: string, name: string) => resource.replace(/^gild(?=$|-)/, name)

async function sha256(text: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
}

export async function install(options: InstallOptions): Promise<Installed> {
  const { template, owner } = options
  const manifest = template.manifest
  const name = options.name ?? manifest.name
  const random = options.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)))
  const cf = new Cloudflare(options.token, options.fetch)
  const a = `/accounts/${options.accountId}`
  const progress = (step: StepId, state: Progress['state'], detail?: string) => options.onProgress?.({ step, state, detail })
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(owner.name)) throw new Error('The owner name must be lowercase letters, digits and dashes')
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+/.test(owner.publicKey)) throw new Error('The owner key must be an ssh-ed25519 public key')
  const publicKey = owner.publicKey.trim().split(/\s+/).slice(0, 2).join(' ')

  progress('account', 'running')
  const account = await cf.get<{ id: string; name: string }>(a)
  progress('account', 'done', account.name)

  progress('subdomain', 'running')
  let subdomain: string
  try {
    subdomain = (await cf.get<{ subdomain: string }>(`${a}/workers/subdomain`)).subdomain
  } catch (error) {
    if (!(error instanceof CloudflareError) || error.status !== 404) throw error
    subdomain = `${name}-${hex(random(3))}`
    await cf.call(`${a}/workers/subdomain`, { method: 'PUT', json: { subdomain } })
  }
  const url = `https://${name}.${subdomain}.workers.dev`
  progress('subdomain', 'done', `${subdomain}.workers.dev`)

  progress('databases', 'running')
  const databases = new Map<string, string>()
  for (const d of manifest.d1_databases) {
    const dbName = rename(d.database_name, name)
    const found = (await cf.get<{ uuid: string; name: string }[]>(`${a}/d1/database?name=${encodeURIComponent(dbName)}`)).find(x => x.name === dbName)
    databases.set(d.binding, found?.uuid ?? (await cf.call<{ uuid: string }>(`${a}/d1/database`, { method: 'POST', json: { name: dbName } })).result.uuid)
  }
  progress('databases', 'done', [...databases.keys()].join(', '))

  progress('bucket', 'running')
  for (const b of manifest.r2_buckets) {
    const bucket = rename(b.bucket_name, name)
    try {
      await cf.get(`${a}/r2/buckets/${bucket}`)
    } catch (error) {
      if (!(error instanceof CloudflareError) || error.status !== 404) throw error
      await cf.call(`${a}/r2/buckets`, { method: 'POST', json: { name: bucket } })
    }
  }
  progress('bucket', 'done')

  progress('queues', 'running')
  const queueNames = new Set([...manifest.queues.producers.map(p => p.queue), ...manifest.queues.consumers.flatMap(c => [c.queue, ...(c.dead_letter_queue ? [c.dead_letter_queue] : [])])])
  const existingQueues = await cf.all<{ queue_id: string; queue_name: string }>(`${a}/queues`)
  const queues = new Map<string, string>()
  for (const q of queueNames) {
    const queueName = rename(q, name)
    const found = existingQueues.find(x => x.queue_name === queueName)
    queues.set(q, found?.queue_id ?? (await cf.call<{ queue_id: string }>(`${a}/queues`, { method: 'POST', json: { queue_name: queueName } })).result.queue_id)
  }
  progress('queues', 'done', `${queues.size} queues`)

  progress('migrations', 'running')
  let applied = 0
  for (const d of manifest.d1_databases) {
    const query = (sql: string) => cf.call<{ results: Record<string, unknown>[] }[]>(`${a}/d1/database/${databases.get(d.binding)}/query`, { method: 'POST', json: { sql } })
    // wrangler's own bookkeeping table, so `wrangler d1 migrations apply` agrees.
    await query('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)')
    const done = new Set(((await query('SELECT name FROM d1_migrations')).result[0]?.results ?? []).map(r => String(r.name)))
    for (const file of d.migrations) {
      if (done.has(file)) continue
      const body = await template.read(`${d.migrations_dir}/${file}`)
      const sql = typeof body === 'string' ? body : new TextDecoder().decode(body)
      await query(`${sql.trim().replace(/;?\s*$/, ';')}\nINSERT INTO d1_migrations(name) VALUES (${sqlString(file)});`)
      applied++
    }
  }
  progress('migrations', 'done', applied ? `${applied} applied` : 'up to date')

  progress('worker', 'running')
  const scripts = await cf.get<{ id: string; migration_tag?: string }[]>(`${a}/workers/scripts`)
  const existing = scripts.find(s => s.id === name)
  const bindings: Record<string, unknown>[] = [
    ...Object.entries({ ...manifest.vars, PUBLIC_ORIGIN: url, CLOUDFLARE_ACCOUNT_ID: options.accountId, ARTIFACTS_EVENTS_QUEUE_ID: queues.get(manifest.queues.consumers.find(c => c.queue.endsWith('-artifacts-events'))?.queue ?? '') ?? '' })
      .map(([key, text]) => ({ type: 'plain_text', name: key, text })),
    ...manifest.d1_databases.map(d => ({ type: 'd1', name: d.binding, id: databases.get(d.binding) })),
    ...manifest.r2_buckets.map(b => ({ type: 'r2_bucket', name: b.binding, bucket_name: rename(b.bucket_name, name) })),
    ...manifest.durable_objects.map(o => ({ type: 'durable_object_namespace', name: o.name, class_name: o.class_name })),
    ...manifest.queues.producers.map(p => ({ type: 'queue', name: p.binding, queue_name: rename(p.queue, name) })),
  ]
  // Secrets are made once; an upgrade keeps them (keep_bindings below).
  if (!existing) {
    const worker = await workerToken(cf, options.accountId, name)
    bindings.push(
      { type: 'secret_text', name: 'SESSION_SECRET', text: hex(random(32)) },
      { type: 'secret_text', name: 'ACTIONS_SECRET_KEY', text: base64(random(32)) },
      // Reads and writes this account's Artifacts and manages its event
      // subscriptions; it never leaves the account.
      { type: 'secret_text', name: 'ARTIFACTS_TOKEN', text: worker ?? options.token },
      { type: 'secret_text', name: 'EVENTS_TOKEN', text: worker ?? options.token },
    )
  }
  const tags = manifest.migrations.map(m => m.tag)
  const pending = manifest.migrations.slice(existing?.migration_tag ? tags.indexOf(existing.migration_tag) + 1 : 0)
  const metadata = {
    main_module: manifest.main,
    compatibility_date: manifest.compatibility_date,
    compatibility_flags: manifest.compatibility_flags,
    ...(manifest.limits ? { limits: manifest.limits } : {}),
    bindings,
    ...(existing ? { keep_bindings: ['secret_text'] } : {}),
    ...(pending.length
      ? { migrations: { ...(existing?.migration_tag ? { old_tag: existing.migration_tag } : {}), new_tag: tags[tags.length - 1], steps: pending.map(({ tag: _tag, ...step }) => step) } }
      : {}),
    observability: { enabled: true },
  }
  const form = new FormData()
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  for (const m of manifest.modules) {
    const body = await template.read(`worker/${m.name}`)
    form.set(m.name, new Blob([body as BlobPart], { type: m.type === 'wasm' ? 'application/wasm' : 'application/javascript+module' }), m.name)
  }
  await cf.call(`${a}/workers/scripts/${name}`, { method: 'PUT', body: form })
  await cf.call(`${a}/workers/scripts/${name}/subdomain`, { method: 'POST', json: { enabled: true, previews_enabled: false } })
  progress('worker', 'done', existing ? 'upgraded' : 'uploaded')

  progress('consumers', 'running')
  for (const c of manifest.queues.consumers) {
    const queueId = queues.get(c.queue)!
    const consumers = await cf.get<{ script?: string; script_name?: string; consumer_id: string }[]>(`${a}/queues/${queueId}/consumers`)
    const settings = {
      ...(c.max_batch_size ? { batch_size: c.max_batch_size } : {}),
      ...(c.max_retries !== undefined ? { max_retries: c.max_retries } : {}),
      ...(c.max_batch_timeout !== undefined ? { max_wait_time_ms: c.max_batch_timeout * 1000 } : {}),
    }
    const body = { type: 'worker', script_name: name, settings, ...(c.dead_letter_queue ? { dead_letter_queue: rename(c.dead_letter_queue, name) } : {}) }
    const mine = consumers.find(x => (x.script ?? x.script_name) === name)
    if (mine) await cf.call(`${a}/queues/${queueId}/consumers/${mine.consumer_id}`, { method: 'PUT', json: body })
    else await cf.call(`${a}/queues/${queueId}/consumers`, { method: 'POST', json: body })
  }
  await cf.call(`${a}/workers/scripts/${name}/schedules`, { method: 'PUT', json: manifest.crons.map(cron => ({ cron })) })
  progress('consumers', 'done')

  progress('owner', 'running')
  const db = databases.get('DB')!
  const query = (sql: string, params: unknown[] = []) => cf.call<{ results: Record<string, unknown>[] }[]>(`${a}/d1/database/${db}/query`, { method: 'POST', json: { sql, params } })
  const claim = (await query('SELECT name, public_key FROM claims WHERE name = ?', [owner.name])).result[0]?.results[0]
  if (claim && claim.public_key !== publicKey) throw new Error(`@${owner.name} on this instance belongs to a different key`)
  if (!claim) {
    await query('INSERT INTO claims (name, public_key, email, email_verified, claimed_at) VALUES (?, ?, ?, 1, ?)', [owner.name, publicKey, owner.email, new Date().toISOString()])
    await query('INSERT OR IGNORE INTO site_admins (name) VALUES (?)', [owner.name])
  }
  const token = `gf_${hex(random(16))}`
  const now = Date.now()
  await query('INSERT INTO api_tokens (token_hash,name,public_key,created_at,expires_at,scopes,repos,label) VALUES (?,?,?,?,?,NULL,NULL,?)', [await sha256(token), owner.name, publicKey, now, now + 5 * 365 * 86_400_000, 'gild desktop'])
  progress('owner', 'done', `@${owner.name}`)

  progress('ready', 'running')
  await ready(url, token, options.fetch)
  progress('ready', 'done', url)
  return { accountId: options.accountId, name, url, token }
}

/** The permissions the Worker itself needs at run time. */
export const WORKER_PERMISSIONS = ['Artifacts Read', 'Artifacts Write', 'Queues Write']

/** A token for the Worker with only WORKER_PERMISSIONS, so the instance never
 *  holds the installer's key. Null when the key may not create tokens; the
 *  install then gives the Worker the key itself. */
async function workerToken(cf: Cloudflare, accountId: string, name: string): Promise<string | null> {
  const a = `/accounts/${accountId}`
  try {
    const groups = await cf.get<{ id: string; name: string }[]>(`${a}/tokens/permission_groups`)
    const ids = WORKER_PERMISSIONS.map(p => groups.find(g => g.name === p)?.id)
    if (ids.some(id => !id)) return null
    const created = await cf.call<{ value: string }>(`${a}/tokens`, { method: 'POST', json: {
      name: `${name} worker`,
      policies: [{ effect: 'allow', resources: { [`com.cloudflare.api.account.${accountId}`]: '*' }, permission_groups: ids.map(id => ({ id })) }],
    } })
    return created.result.value
  } catch (error) {
    if (error instanceof CloudflareError && (error.status === 403 || error.codes.includes(10000) || error.codes.includes(9109))) return null
    throw error
  }
}

/** A new workers.dev name takes a little while to resolve. */
async function ready(url: string, token: string, fetch: Fetch) {
  const deadline = Date.now() + 120_000
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/v1/user/account`, { headers: { authorization: `Bearer ${token}` } })
      if (res.ok) return
      last = `HTTP ${res.status}`
    } catch (error) {
      last = String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error(`The instance at ${url} did not answer: ${last}`)
}
