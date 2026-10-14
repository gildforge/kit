import { streamPush } from '../engine/git-push-stream.js'
import { repoWrite } from './repo-write.js'
import { preparePush } from './git-push-budget.js'
import type { R2Bucket } from '@cloudflare/workers-types'
import { checkRefBudget, REPO_BYTES, PUSHES_PER_HOUR } from '../engine/git-limits.js'
import { metering } from './hosted.js'
import { ApiError } from '../engine/api/errors.js'
import { getCloudflareContext } from './context.js'
import type { ApiControl } from './api/control-do.js'
import { mayRead, repoAccess, privateAcl } from './repo-read.js'
import { readyIndex } from './repo-index.js'
import { defaultAdvertisement, defaultRefsRequest } from '../engine/git-default.js'
import { runQueue, scheduleActions, triggerPush } from './actions/service.js'
import { repoIndex, scheduleIndex } from './repo-index.js'
import { publishPushPresentation, publishPushBatches } from '../engine/push-presentation.js'
import { listRefs } from './repo-refs-live.js'
import { mintRepoToken, repoInfo, repoRemote } from './artifacts.js'
import { store } from './backend.js'
import { verifyToken } from './tokens.js'
import { hasScope, permitsRepo, type Principal } from '../engine/api/scopes.js'
import { capabilities, mayWrite } from './access.js'

// Git smart-HTTP uses the shared read policy for private repositories.
// Pushes require a gild API token whose identity may write the
// repo — the owner themselves, or an owner/admin of the owning org.
// The proxy trades that gild token for a short-lived repo-scoped Artifacts
// token — users never see Cloudflare credentials.

export interface GitParams {
  owner: string
  repo: string
  path?: string[]
}

function isWrite(path: string[], service: string | null) {
  const tail = path.join('/')
  return (
    tail === 'git-receive-pack' ||
    (tail === 'info/refs' && service === 'git-receive-pack')
  )
}

export async function gitProxy(request:Request,params:GitParams) {
  try {
    if(request.method==='POST' && params.path?.join('/')==='git-receive-pack') return await repoWrite(params.owner,params.repo.replace(/\.git$/,''),()=>gitProxyInner(request,params))
    return await gitProxyInner(request,params)
  } catch (e) {
    // Next answers a bare 500 and logs only the stack; name the failure.
    console.error('git proxy failed', request.method, params.owner, params.repo, params.path?.join('/'), e instanceof Error ? `${e.name}: ${e.message}` : e)
    throw e
  }
}
async function gitProxyInner(request: Request, params: GitParams, packageWriter?:Principal) {
  const path = params.path ?? []
  const repoName = params.repo.replace(/\.git$/, '')
  const url = new URL(request.url)
  const service = url.searchParams.get('service')
  const write = isWrite(path, service)
  let body: BodyInit | null = null
  let lsRefs = false
  const defaultBranch = (
    await (await store()).settings.state(`${params.owner}/${repoName}`)
  ).defaultBranch
  let reservation: { control: ApiControl; id: string } | null = null
  let staged: Awaited<ReturnType<typeof preparePush>> | null = null
  try {
  let actor = '',
    updates: { ref: string; before: string; sha: string }[] = []

  const authorization = request.headers.get('authorization') ?? ''
  let runnerToken = authorization.replace(/^Bearer /i, '')
  if (/^Basic /i.test(authorization)) {
    try {
      runnerToken = atob(authorization.slice(6)).split(':').slice(1).join(':')
    } catch {
      runnerToken = ''
    }
  }
  if (
    runnerToken.startsWith('gro_') ||
    runnerToken.startsWith('grt_') ||
    (write && runnerToken.startsWith('gc_'))
  )
    return new Response('runner credential cannot access this operation', {
      status: 403,
    })
  if (
    !write &&
    (runnerToken.startsWith('gr_') || runnerToken.startsWith('gc_'))
  ) {
    try {
      await (await runQueue(params.owner, repoName)).readRepo(runnerToken)
    } catch {
      return new Response('invalid or revoked runner token', {
        status: 401,
      })
    }
  }

  let importActor:string|null=null
  if(runnerToken.startsWith('gi_')) {
    try {const job=await (await (await import('./import/service.js')).importJob(params.owner,repoName)).authorize(runnerToken);importActor=job.by ?? params.owner}catch{return new Response('Invalid import lease',{status:401})}
  }
  const st = await store(),
    services = { store: st, index: readyIndex },
    policy = await repoAccess(services, params.owner, repoName)
  if (!policy)
    return new Response('Not found', {
      status: 401,
      headers: {
        'www-authenticate': 'Basic realm="gild"',
        'cache-control': 'private, no-store',
      },
    })
  const internalPrefix = policy.internalPrefix
  // Protocol v2 sends ls-refs and fetch as the same POST; read the (small)
  // request to tell them apart: only a fetch is a billed operation.
  if (
    !write &&
    request.method === 'POST' &&
    request.headers.get('git-protocol')?.includes('version=2')
  ) {
    const bytes = await request.arrayBuffer()
    const text = new TextDecoder().decode(bytes)
    lsRefs = text.includes('command=ls-refs')
    body = lsRefs && (defaultBranch || internalPrefix) ? new TextEncoder().encode(defaultRefsRequest(text, defaultBranch??'main')) : bytes
  }
  const privateRead = policy.pending || privateAcl(policy.acl)
  if (!write && privateRead && !importActor && !/^(gr|gc)_/.test(runnerToken)) {
    const identity = runnerToken ? await verifyToken(runnerToken) : null
    const principal = identity?.name
      ? { id: '', ...identity, name: identity.name }
      : null
    if (
      !principal ||
      !hasScope(principal, 'repo:read') ||
      !permitsRepo(principal, params.owner, repoName) ||
      !(await mayRead(services, params.owner, repoName, principal.name, policy))
    )
      return new Response('Not found', {
        status: 401,
        headers: {
          'www-authenticate': 'Basic realm="gild"',
          'cache-control': 'private, no-store',
        },
      })
  }
  if (write) {
    const auth = request.headers.get('authorization') ?? ''
    // git sends the token as Bearer, or via HTTP Basic in the password slot
    // (what a credential helper answers with).
    let gildToken = ''
    if (/^bearer\s+/i.test(auth)) gildToken = auth.replace(/^bearer\s+/i, '')
    else if (auth.startsWith('Basic ')) {
      gildToken =
        Buffer.from(auth.slice(6), 'base64').toString().split(':')[1] ?? ''
    }
    const identity = packageWriter ?? (importActor?{name:importActor,publicKey:'',scopes:['repo:read','repo:write'],repos:[`${params.owner}/${repoName}`]}:gildToken ? await verifyToken(gildToken) : null)
    if (
      identity?.name &&
      (!hasScope({ id: '', ...identity, name: identity.name }, 'repo:write') ||
        !permitsRepo(
          { id: '', ...identity, name: identity.name },
          params.owner,
          repoName,
        ))
    )
      return new Response(
        'token scope or repository allow-list forbids this push',
        { status: 403 },
      )
    const can = importActor?{writer:true,grants:new Set<string>()}:await capabilities(
      params.owner,
      repoName,
      identity?.name ?? null,
    )
    if (
      !identity ||
      (policy.pending &&
        !(await mayWrite(params.owner, identity.name ?? null))) ||
      !(can.writer || can.grants.has('pr'))
    ) {
      return new Response(
        'push requires a gild token with write access to this repo (gild auth token)',
        {
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="gild"' },
        },
      )
    }
    // An unpaid or deleted account is read-only: its own pushes, and pushes to
    // its repositories, are refused (lib/accounts.ts).
    if (write && !importActor) {
      const { getCloudflareContext } = await import('./context.js')
      const { env } = await getCloudflareContext({ async: true })
      const { account, accountWrites } = await import('./accounts.js')
      const db = (env as unknown as { DB: import('@cloudflare/workers-types').D1Database }).DB
      for (const name of new Set([(identity?.name ?? params.owner).split('/')[0], params.owner].map(n => n.toLowerCase()))) {
        const refused = accountWrites(await account(db, name))
        if (refused) return new Response(refused.message, { status: refused.status, headers: { 'cache-control': 'private, no-store' } })
      }
    }
    // An import or mirror owns the refs until cutover: its next sync would
    // force-push over anything pushed here, so refuse instead of losing it.
    if (!importActor) {
      const { getCloudflareContext } = await import('./context.js')
      const { env } = await getCloudflareContext({ async: true })
      const { importOwnsRefs } = await import('../engine/import/fence.js')
      const owned = await importOwnsRefs(
        (env as unknown as { DB?: import('../engine/import/fence.js').FenceDB }).DB,
        `${params.owner}/${repoName}`,
      )
      if (owned)
        return new Response(
          'This repository is being imported or mirrored. Pushes are refused until cutover (gild import cutover).',
          { status: 409, headers: { 'cache-control': 'private, no-store' } },
        )
    }

    // _meta is forge-managed: the Worker writes it server-side, users never
    // push it. Inspect the ref commands riding ahead of the pack.
    if (request.method === 'POST' && path.join('/') === 'git-receive-pack') {
      const ns = (await getCloudflareContext()).env as unknown as {
        FRAGMENTS: R2Bucket
        API_CONTROL: { idFromName(s: string): unknown; get(id: unknown): ApiControl }
      }
      const limiter = ns.API_CONTROL.get(ns.API_CONTROL.idFromName(`push-account:${identity.name}`))
      const rate = await limiter.rate(Date.now(), PUSHES_PER_HOUR)
      if (!rate.allowed) return new Response('Push rate limit: 300 pushes per account per hour', {
        status: 429, headers: { 'retry-after': String(Math.max(1, rate.reset - Math.floor(Date.now() / 1000))) },
      })
      let pushed: Awaited<ReturnType<typeof streamPush>>
      try { pushed = await streamPush(request) }
      catch (error) {
        if (error instanceof ApiError) return new Response(error.message, { status: error.status })
        throw error
      }
      if (!pushed.updates.length) {
        await pushed.body.cancel()
        return new Response(null,{status:200,headers:{'content-type':'application/x-git-receive-pack-result','cache-control':'no-store'}})
      }
      if(importActor && pushed.refs.some(r=>r==='refs/heads/_meta' || !/^refs\/(heads|tags)\//.test(r))) return new Response('Imports may update code branches and tags only',{status:403})

      // Agents push branches; their work reaches the default branch only
      // through the merge queue.
      if (!can.writer) {
        const main = `refs/heads/${(await repoInfo(params.owner, repoName)).default_branch}`
        const forbidden = pushed.refs.filter(
          (r) => r === main || r.startsWith('refs/tags/'),
        )
        if (forbidden.length) {
          return new Response(
            `@${identity.name} may push branches here, not ${forbidden.join(', ')}. Open a pull request; the merge queue lands it.`,
            { status: 403 },
          )
        }
      }
      if (
        pushed.refs.includes('refs/heads/_meta') &&
        !(await mayWrite(params.owner, identity.name ?? null))
      ) {
        return new Response(
          'refs/heads/_meta is managed by the forge — issues, PRs and CI metadata are written by gild itself. Push to main or a feature branch.',
          { status: 403 },
        )
      }
      const state = await st.settings.state(`${params.owner}/${repoName}`)
      const index = await repoIndex(params.owner, repoName)
      const indexed = await index?.refs()
      const refs = indexed?.refs ?? []
      try { checkRefBudget(refs.map(r => `refs/${r.kind === 'tag' ? 'tags' : 'heads'}/${r.name}`), pushed.updates) }
      catch (error) {
        if (error instanceof ApiError) return new Response(error.message, { status: error.status })
        throw error
      }
      const budget = ns.API_CONTROL.get(ns.API_CONTROL.idFromName(`push-budget:${state.id}`))
      const id = crypto.randomUUID()
      try {
        const tips = [...new Set([...pushed.updates.map(u=>u.before).filter(h=>!/^0+$/.test(h)),...refs.map(r=>r.hash),...(indexed?.meta ? [indexed.meta] : [])])]
        // A thin pack's bases sit in the tips the client saw. The index can
        // lag a push that just landed (an import pushes branches, then PR
        // heads), so on a miss read the live tips once and look there.
        let live: string[] | null = null
        staged = await preparePush(ns.FRAGMENTS, pushed.body, async hash => {
          try { return await index!.deltaBase(hash, tips) }
          catch (error) {
            live ??= await listRefs(params.owner, repoName).then(r => [...r.branches, ...r.tags].map(x => x.oid).filter(t => !tips.includes(t)), () => [])
            if (!live.length) throw error
            return index!.deltaBase(hash, live)
          }
        })
      } catch (error) {
        if (error instanceof ApiError) return new Response(error.message, { status: error.status })
        throw error
      }
      const initial = await index?.storageObjects() ?? []
      if (!await budget.reserveObjects(id, staged.objects, initial, REPO_BYTES))
        return new Response('Repository exceeds the 5 GiB unique-object storage budget (including history)', { status: 413 })
      reservation = { control: budget, id }
      const replay = await ns.FRAGMENTS.get(staged.key)
      if (!replay) throw new Error('Staged push unavailable')
      const meta = pushed.updates.find((u) => u.ref === 'refs/heads/_meta')
      if (meta) {
        await st.fenceRepoAccess(
          (await st.settings.state(`${params.owner}/${repoName}`)).id,
          meta.sha,
        )
        await (
          await repoIndex(params.owner, repoName)
        )?.refresh(params.owner, repoName)
      }
      actor = identity.name ?? 'unknown'
      updates = pushed.updates
      body = replay.body as unknown as ReadableStream
    }
  }

  const minted = await mintRepoToken(
    params.owner,
    repoName,
    write ? 'write' : 'read',
  )
  const target = `${await repoRemote(params.owner, repoName)}/${path.join('/')}${url.search}`

  const headers = new Headers()
  for (const name of [
    'content-type',
    'accept',
    'git-protocol',
    ...(write && body ? [] : ['content-encoding']),
  ]) {
    const v = request.headers.get(name)
    if (v) headers.set(name, v)
  }
  headers.set('authorization', `Bearer ${minted.plaintext}`)

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body:
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : (body ?? request.body),
    // @ts-expect-error streaming request bodies need half duplex
    duplex: 'half',
  })

  if (
    upstream.ok &&
    request.method === 'POST' &&
    path.join('/') === 'git-receive-pack'
  ) {
    const report = new TextDecoder().decode(
      await upstream.clone().arrayBuffer(),
    )
    if(!importActor)await scheduleIndex(params.owner, repoName)
    // receive-pack may return HTTP 200 with ng statuses. Only accepted refs trigger.
    const accepted = updates.filter((u) => report.includes(`ok ${u.ref}\n`))
    if (reservation) {
      await reservation.control.finishObjects(reservation.id, accepted.length > 0)
      reservation = null
    }
    if (accepted.length && staged) await (await repoIndex(params.owner,repoName))?.recordStorageObjects(staged.objects)
    if (accepted.length)
      await (
        await repoIndex(params.owner, repoName)
      )?.recordPush(crypto.randomUUID(), accepted, actor, !!importActor)
    if (accepted.length && !importActor)
      await scheduleActions(async () => {
        for (const u of accepted)
          await triggerPush(params.owner, repoName, u, actor)
      })
    if (accepted.length && !importActor) {
      const index = await repoIndex(params.owner, repoName)
      const { env, ctx } = await getCloudflareContext()
      const renderer = (env as Record<string, unknown>).GILD_RENDER as
        { fetch(url: string, init: RequestInit): Promise<Response> } | undefined
      // The push has landed: rendering it must never turn that into a failure
      // for the client, so it runs after the response.
      if (index && renderer) ctx.waitUntil(
        publishPushPresentation(index, params.owner, repoName,
          () => listRefs(params.owner, repoName), async () => {
            const state = await (await store()).settings.state(`${params.owner}/${repoName}`)
            try {
              await publishPushBatches(renderer, { entity: state.id, repository: `${params.owner}/${repoName}` })
            } catch (error) { throw new ApiError(503, (error as Error).message) }
          })
          .catch(error => console.error('push presentation failed', params.owner, repoName, error instanceof Error ? error.message : error)))
    }
  }
  if (upstream.ok && request.method === 'POST') {
    const op = path.join('/')
    const kind = op === 'git-receive-pack'
      ? (updates.length ? 'pushed' as const : null)
      : op === 'git-upload-pack' && !lsRefs ? 'fetched' as const : null
    if (kind) await meter(params.owner, repoName, kind, kind === 'pushed')
  }
  if (!upstream.ok && reservation) { await reservation.control.finishObjects(reservation.id,false); reservation = null }
  const out = new Headers()
  for (const name of ['content-type', 'cache-control', 'expires', 'pragma']) {
    const v = upstream.headers.get(name)
    if (v) out.set(name, v)
  }
  const advertisement =
    upstream.ok &&
    (defaultBranch || internalPrefix) &&
    (lsRefs ||
      (request.method === 'GET' &&
        path.join('/') === 'info/refs' &&
        service === 'git-upload-pack'))
      ? defaultAdvertisement(await upstream.text(), defaultBranch??'main', lsRefs ? 'v2' : 'v0', !importActor?internalPrefix:undefined)
      : upstream.body
  if (privateRead) out.set('cache-control', 'private, no-store')
  return new Response(advertisement, {
    status: upstream.status,
    headers: out,
  })
  } finally {
    // A network error or missing status report is ambiguous; refund and let the
    // repository index establish what actually arrived.
    if (reservation) await reservation.control.finishObjects(reservation.id,false)
    if (staged) await staged.cleanup()
  }
}

/** Internal fixed-file bridge. External Git handlers never pass a browser principal. */
export async function pushPackageManifest(request:Request,params:GitParams,principal:Principal) {
 if(principal.anonymous||principal.name.includes('/')||!hasScope(principal,'repo:write')||!permitsRepo(principal,params.owner,params.repo.replace(/\.git$/,'')))throw new ApiError(403,'Repository writer required')
 if(request.method!=='POST'||params.path?.join('/')!=='git-receive-pack')throw new ApiError(400,'Invalid package push')
 return repoWrite(params.owner,params.repo.replace(/\.git$/,''),()=>gitProxyInner(request,params,principal))
}

/** One operation for the repository's owner, recorded by the hosted
 *  service's metering (lib/hosted) after the response. A push also
 *  re-measures the repository's storage. A self-hosted gild records nothing. */
async function meter(owner: string, repo: string, kind: 'pushed' | 'fetched', measure: boolean) {
  const { env, ctx } = await getCloudflareContext({ async: true })
  const db = (env as unknown as { DB?: import('@cloudflare/workers-types').D1Database }).DB
  const hosted = metering()
  if (!db || !hosted) return
  const { recordUsage, recordStorage } = hosted
  ctx.waitUntil((async () => {
    await recordUsage(db, [{ owner, repo, source: 'user', kind, count: 1 }])
    if (measure) {
      const bytes = await (await repoIndex(owner, repo))?.storageBytes()
      if (typeof bytes === 'number') await recordStorage(db, owner, repo, bytes)
    }
  })().catch(error => console.error('metering failed', owner, repo, kind, error)))
}
