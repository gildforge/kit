import { viewerShell } from '../../presentation/viewer-shell.js'
import { historyLimited } from './rate.js'
import { preparingPage, rendererShell, stillPreparing } from '../../engine/status-pages.js'
import { contextHTML, escapeHTML } from '../../render/context.js'
import { selectHTML } from '../../render/selection.js'
import { numberLines } from '../../render/lines.js'
import { PENDING_HTML } from '../../render/pending.js'
import type { R2Bucket, Fetcher, Queue } from '@cloudflare/workers-types'
import {
  fragmentKey,
  fragmentURL,
  validFragment,
  RENDER_VERSION,
  PUBLIC_CACHE,
  PUBLIC_EDGE_CACHE,
  digest,
  ASSET_CACHE,
  PRIVATE_CACHE,
  type Fragment,
} from '../../render/address.js'
import type { PagePointer, RenderItem, RenderJob } from '../../engine/fragments.js'

export interface FragmentEnv {
  SESSION_SECRET?: string
  FRAGMENTS: R2Bucket
  GILD_RENDER: Pick<Fetcher, 'fetch'>
  RENDER_QUEUE: Pick<Queue<RenderJob>, 'send'>
}
export interface ReadAddress {
  entity: string
  repository: string
  scope: string
}
export interface FragmentReads {
  publicPointer?(request: Request, owner: string, repo: string, ref?: string, path?: string, page?: string, sha?: string): Promise<PagePointer | null>
  coldHistory?(request: Request, address: ReadAddress, sha: string): Promise<Response | null>
  publicAccess?(request: Request, fragment: Fragment): Promise<boolean>
  access(
    request: Request,
    owner: string,
    repo: string,
  ): Promise<ReadAddress | null>
  pointer(
    request: Request,
    owner: string,
    repo: string,
    ref?: string,
    path?: string,
    page?: string,
    sha?: string,
  ): Promise<PagePointer | null>
}
export function timed(response: Response, start: number, phases = '') {
  if (response.status===101) return response
  const out = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    ...{ encodeBody: 'manual' },
  })
  out.headers.set(
    'server-timing',
    [
      response.headers.get('server-timing'),
      phases,
      `total;dur=${(performance.now() - start).toFixed(2)}`,
    ]
      .filter(Boolean)
      .join(', '),
  )
  return out
}
const fail = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: {
      'cache-control': PRIVATE_CACHE,
      'x-content-type-options': 'nosniff',
    },
  })
async function enqueueArtifact(env: FragmentEnv, address: ReadAddress, item: RenderItem, meta: string | null = null) {
  await env.RENDER_QUEUE.send({ entity: address.entity, repository: address.repository,
    oldTip: null, newTip: item.sha, meta, item })
}
function pendingArtifact() {
  return Response.json({ state: 'pending', retryAfter: 3 }, { status: 202,
    headers: { 'cache-control': PRIVATE_CACHE, 'retry-after': '3', 'x-gild-state': 'pending' } })
}
function parseFragment(url: URL) {
  const publicPath = url.pathname.match(/^\/f\/(v\d+)\/([^/]+)\/([^/]+)$/),
    privatePath = url.pathname.match(
      /^\/pf\/([^/]+)\/([^/]+)\/(v\d+)\/([^/]+)\/([^/]+)$/,
    )
  if (!publicPath && !privatePath) return null
  const [, version, kind, hash] = publicPath ?? privatePath!.slice(2)
  if (!/^v[1-9][0-9]*$/.test(version) || !validFragment(kind, hash))
    return { invalid: true as const }
  return {
    invalid: false as const,
    fragment: { kind, hash, version } as Fragment,
    privateRepo: privatePath ? [privatePath[1], privatePath[2]] : null,
  }
}
async function objectResponse(
  env: FragmentEnv,
  request: Request,
  key: string,
  privateRead: boolean,
) {
  const start = performance.now(),
    object = await env.FRAGMENTS.get(key)
  if (!object) return null
  const headers = new Headers({
    'content-type':
      object.httpMetadata?.contentType ?? 'text/html; charset=utf-8',
    'cache-control': privateRead ? PRIVATE_CACHE : key.includes('/shell/') && /\.[a-f0-9]{64}$/.test(key)?ASSET_CACHE:PUBLIC_CACHE,
    'x-content-type-options': 'nosniff',
    etag: object.httpEtag,
    'server-timing': `r2;dur=${(performance.now() - start).toFixed(2)}, render;dur=0;desc="stored HTML"${privateRead ? '' : ', do;dur=0, d1;dur=0'}`,
  })
  if (object.httpMetadata?.contentDisposition)
    headers.set('content-disposition', object.httpMetadata.contentDisposition)
  if (privateRead) headers.set('vary', 'Cookie, Authorization')
  if (!privateRead && request.headers.get('if-none-match') === object.httpEtag)
    return new Response(null, { status: 304, headers })
  let body: ReadableStream | null =
    request.method === 'HEAD'
      ? null
      : (object.body as unknown as ReadableStream)
  if (object.httpMetadata?.contentEncoding === 'gzip') {
    if (/\bgzip\b/.test(request.headers.get('accept-encoding') ?? ''))
      headers.set('content-encoding', 'gzip')
    else if (body) body = body.pipeThrough(new DecompressionStream('gzip'))
  }
  return new Response(body, { headers, ...{ encodeBody: 'manual' } })
}
/** Called before settings/OpenNext. Public provenance and current D1 access
 * precede every R2 or edge-cache read; a warm hit never bypasses authorization. */
export async function fragmentHTTP(
  request: Request,
  env: FragmentEnv,
  reads: FragmentReads,
  ctx?: { waitUntil(work: Promise<unknown>): void },
) {
  const start = performance.now(),
    url = new URL(request.url),
    route = parseFragment(url)
  if (!route) return null
  if (route.invalid) return timed(fail(404, 'Not found'), start)
  if (!['GET', 'HEAD'].includes(request.method))
    return timed(fail(405, 'Method not allowed'), start)
  let address: ReadAddress | null = null
  // Gate BEFORE even a warm edge hit: hashes published while public are revoked
  // immediately by the current D1 policy. Unknown/legacy hashes fail closed.
  if(!route.privateRepo && reads.publicAccess && !await reads.publicAccess(request,route.fragment)) {
    const parts=url.searchParams.get('repo')?.split('/'),sha=url.searchParams.get('sha')
    if(!parts || parts.length!==2 || !sha || (sha!=='empty'&&!/^[a-f0-9]{40}$/.test(sha)))return timed(fail(404,'Not found'),start)
    const access=await reads.access(request,parts[0],parts[1])
    if(!access||access.scope)return timed(fail(404,'Not found'),start)
    address = access
    // Unknown provenance stays unreadable while the producer validates its
    // repository membership. Even legacy R2 hits cannot trigger a Git scan.
    const limited = await reads.coldHistory?.(request, access, sha)
    if (limited) return limited
    await enqueueArtifact(env, access, { fragment: route.fragment, sha, path: url.searchParams.get('path') ?? undefined })
    return timed(pendingArtifact(), start, 'render;dur=0;desc="queued preparation"')
  }
  const edge =
      !route.privateRepo &&
      ctx &&
      /\bgzip\b/.test(request.headers.get('accept-encoding') ?? '')
        ? (caches as unknown as { default: Cache }).default
        : null,
    cacheRequest = new Request(url.origin + url.pathname, {
      headers: { 'accept-encoding': 'gzip' },
    })
  if (edge) {
    const cached = await edge.match(cacheRequest)
    if (cached) {
      const unchanged =
        request.headers.get('if-none-match') === cached.headers.get('etag')
      return timed(
        new Response(
          unchanged || request.method === 'HEAD' ? null : cached.body,
          {
            status: unchanged ? 304 : cached.status,
            headers: { ...Object.fromEntries(cached.headers),
              'cache-control':route.fragment.kind==='shell' && /\.[a-f0-9]{64}$/.test(route.fragment.hash)?ASSET_CACHE:PUBLIC_CACHE },
            ...{ encodeBody: 'manual' },
          },
        ),
        start,
        'cache;desc="Cloudflare edge hit", r2;dur=0, render;dur=0, do;dur=0, d1;dur=0',
      )
    }
  }
  if (route.privateRepo) {
    address = await reads.access(
      request,
      ...(route.privateRepo as [string, string]),
    )
    if (!address) return timed(fail(404, 'Not found'), start)
  }
  const key = fragmentKey(route.fragment, address?.scope ?? ''),
    hit = await objectResponse(env, request, key, !!route.privateRepo)
  if (hit) {
    if (edge && hit.status === 200 && request.method === 'GET') {
      const source = hit.clone()
      const headers = new Headers(source.headers)
      headers.delete('content-encoding'); headers.delete('content-length')
      // Cache API owns response encoding. Store decoded bytes so a cache hit
      // cannot double-encode the already compressed R2 body.
      const cached = new Response(source.headers.get('content-encoding') === 'gzip'
        ? source.body!.pipeThrough(new DecompressionStream('gzip')) : source.body, { headers })
      cached.headers.delete('server-timing')
      cached.headers.set('cache-control',PUBLIC_EDGE_CACHE)
      ctx!.waitUntil(edge.put(cacheRequest, cached))
    }
    return timed(
      hit,
      start,
      route.privateRepo ? 'access;desc="shared read check"' : '',
    )
  }
  // Bare immutable URLs never probe git or arbitrary objects. A cold reader
  // supplies a repo+commit context, verified by renderData in the owning DO.
  const repository = address?.repository ?? url.searchParams.get('repo'),
    sha = url.searchParams.get('sha')
  if (!repository || !sha || (sha !== 'empty' && !/^[a-f0-9]{40}$/.test(sha)))
    return timed(fail(404, 'Fragment not found'), start)
  if (!address) {
    const parts = repository.split('/')
    if (parts.length !== 2) return timed(fail(404, 'Not found'), start)
    address = await reads.access(request, parts[0], parts[1])
    if (!address || address.scope) return timed(fail(404, 'Not found'), start)
  }
  const limited = await reads.coldHistory?.(request, address, sha)
  if (limited) return limited
  await enqueueArtifact(env, address, {
        fragment: route.fragment,
        sha,
        path: url.searchParams.get('path') ?? undefined,
  })
  return timed(pendingArtifact(), start, 'render;dur=0;desc="queued preparation"')
}
export async function pointerHTTP(request: Request, reads: FragmentReads, publicOnly = false) {
  const start = performance.now(),
    url = new URL(request.url),
    match = url.pathname.match(/^\/api\/fragments\/([^/]+)\/([^/]+)$/)
  if (!match) return null
  if (request.method !== 'GET')
    return timed(fail(405, 'Method not allowed'), start)
  let pointer: PagePointer | null
  try { pointer = await (publicOnly ? reads.publicPointer! : reads.pointer)(
    request,
    match[1],
    match[2],
    url.searchParams.get('ref') ?? undefined,
    url.searchParams.get('path') ?? '',
    url.searchParams.get('page') ?? 'code',
    url.searchParams.get('sha') ?? undefined,
  ) } catch (error) {
    if (!stillPreparing(error)) throw error
    return timed(pendingArtifact(), start)
  }
  if (publicOnly && !pointer) return null
  return timed(
    pointer
      ? Response.json(pointer, { headers: { 'cache-control': PRIVATE_CACHE } })
      : fail(404, 'Not found'),
    start,
    'pointer;desc="indexed addresses", render;dur=0',
  )
}
async function storedText(
  env: FragmentEnv,
  pointer: PagePointer,
  fragment: Fragment,
  path?: string,
  sha = pointer.tip,
  onCold?: () => Promise<void>,
) {
  const key = fragmentKey(
    { ...fragment, version: pointer.version },
    fragment.kind === 'shell' ? '' : pointer.scope,
  )
  const object = await env.FRAGMENTS.get(key)
  if (!object) {
    if (fragment.kind !== 'shell') await onCold?.()
    if (fragment.kind !== 'shell') await enqueueArtifact(env, pointer, { fragment, path, sha }, pointer.meta)
    throw Object.assign(new Error('Fragment unavailable'), { pending: true })
  }
  return new Response(
    object.httpMetadata?.contentEncoding === 'gzip'
      ? (object.body as unknown as ReadableStream).pipeThrough(
          new DecompressionStream('gzip'),
        )
      : (object.body as unknown as ReadableStream),
  ).text()
}
/** Public shareable URLs and no-JS first loads: stitch stored strings only.
 * No React, cqx, Shiki, git, markdown or Next server components here. */
export async function browseHTTP(
  request: Request,
  env: FragmentEnv,
  reads: FragmentReads,
  ctx?: { waitUntil(work: Promise<unknown>): void },
  publicOnly = false,
) {
  const start = performance.now(),
    url = new URL(request.url),
    match = url.pathname.match(
      /^\/([^/]+)\/([^/]+)(?:\/(score|commit\/([a-f0-9]{4,40})))?\/?$/,
    )
  if (
    !match ||
    !['GET', 'HEAD'].includes(request.method) ||
    ['api', 'git', 'auth', 'settings', 'orgs', 'new', 'import', 'dashboard', 'explore', 'agents', 'keys', 'runners', 'docs', 'brand', 'f', 'pf', 'gild-fragments', '_next'].includes(
      match[1],
    )
  )
    return null
  // Next RSC/prefetch fetches must not be handed HTML as Flight data. The
  // global intent router intercepts these links; existing Next links hard-load.
  if (request.headers.has('rsc'))
    return timed(
      new Response(null, {
        status: 409,
        headers: {
          'x-gild-location': url.pathname + url.search,
          'cache-control': PRIVATE_CACHE,
        },
      }),
      start,
      'render;dur=0;desc=\"fragment navigation required\"',
    )
  const pointerStart = performance.now()
  const page = match[3]?.startsWith('commit')
    ? 'commit'
    : match[3] === 'score'
      ? 'score'
      : 'code'
  const pointer = await (publicOnly ? reads.publicPointer! : reads.pointer)(
    request,
    match[1],
    match[2],
    url.searchParams.get('ref') ?? undefined,
    url.searchParams.get('path') ?? '',
    page,
    match[4],
  )
  if (
    page === 'commit' &&
    pointer?.selected?.hash &&
    match[4] !== pointer.selected.hash
  ) {
    url.pathname = `/${pointer.repository}/commit/${pointer.selected.hash}`
    return timed(
      new Response(null, {
        status: 308,
        headers: { location: url.toString(), 'cache-control': PRIVATE_CACHE },
      }),
      start,
    )
  }
  const pointerMs = performance.now() - pointerStart
  if (!pointer) return null // Preserve the site's shared Missing page and identity shell.
  let coldCheck: Promise<void> | undefined
  const text = (fragment: Fragment, path?: string, sha = pointer.tip) => storedText(env,pointer,fragment,path,sha,() => {
    // One charge per full-page cold render, even when several fragments miss.
    coldCheck ??= (async () => {
      const limited = await reads.coldHistory?.(request,pointer,sha)
      if (limited) throw Object.assign(new Error('Cold history render rate limit exceeded'), {
        status:429,retryAfter:limited.headers.get('retry-after'),latest:'/'+pointer.repository,
      })
    })()
    return coldCheck
  })
  if (url.searchParams.get('raw') === '1') {
    const manifest = JSON.parse(
        await text(pointer.manifest),
      ) as import('../../engine/fragments.js').TipManifest,
      file = manifest.files.find((f) => f.path === pointer.path)
    if (!file) return timed(fail(404, 'Not found'), start)
    const raw = new URL(
      fragmentURL(
        { ...file.source, version: pointer.version },
        pointer.scope ? pointer.repository : undefined,
      ),
      request.url,
    )
    raw.search = new URLSearchParams({
      repo: pointer.repository,
      sha: pointer.tip,
      path: file.path,
    }).toString()
    return new Response(null, {
      status: 302,
      headers: { location: raw.toString(), 'cache-control': PRIVATE_CACHE },
    })
  }
  // Current access/pointer resolution always precedes this cache. It contains
  // viewer-neutral chrome only; cookie geometry is applied after every hit/miss.
  const edge = !pointer.scope && ctx ? (caches as unknown as { default: Cache }).default : null
  const cacheRequest = new Request(url.origin + '/__gild-page/' + await digest(JSON.stringify([
    'viewer-neutral-v1', pointer, page, [...url.searchParams].sort(),
  ])))
  const cached = await edge?.match(cacheRequest)
  if (cached) return timed(new Response(request.method === 'HEAD' ? null : cached.body, {
    headers: { ...Object.fromEntries(cached.headers), 'cache-control': PUBLIC_CACHE },
  }), start, `index;dur=${pointerMs.toFixed(2)}, page;desc="stitched edge hit", r2;dur=0, render;dur=0`)
  try {
    const r2Start = performance.now()
    let pending = false
    const available = (fragment: Fragment, path?: string, sha?: string) => text(fragment, path, sha).catch(error => {
      if (!(error as {pending?: boolean}).pending) throw error
      pending = true
      return PENDING_HTML
    })
    const [shell, home, selected, score] = await Promise.all([
      text(pointer.shell),
      text(pointer.home),
      pointer.selected
        ? available(
            pointer.selected,
            pointer.path,
            page === 'commit' ? match[4] : pointer.tip,
          )
        : '<p>No README yet. Pick a file on the left to read it.</p>',
      pointer.score
        ? available(pointer.score, undefined, match[4])
        : '',
    ])
    let content = home
    if (page !== 'code') {
      const body = content.indexOf('<div data-page-body="">')
      content =
        content.slice(0, body + '<div data-page-body="">'.length) +
        selectHTML(selected.replace('<!--gild-score-->', score), url) +
        '</div></div>'
    } else
      content = content
        .replace(
          '<!--gild-file-->',
          contextHTML(
            numberLines(selected),
            pointer,
            pointer.selected?.kind === 'tree' ? pointer.path : '',
          ),
        )
        .replace(
          '<span data-file-name="">README</span>',
          `<span data-file-name="">${escapeHTML(pointer.path || 'README')}</span>`,
        )
    content = contextHTML(content, pointer)
    const boot = `<script type="application/json" id="gild-pointer">${JSON.stringify(pointer).replaceAll('<', '\\u003c')}</script>`
    const [head, tail] = viewerShell(shell, url, false).split('<!--gild-content-->')
    content = viewerShell(content, url, false)
    // Stream concatenation, never render the website on a code request.
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of [head, content, boot, tail])
          controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    const response = new Response(stream, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': pending || pointer.scope ? PRIVATE_CACHE : PUBLIC_CACHE,
          ...(pending ? { 'x-gild-state': 'pending' } : {}),
          'x-content-type-options': 'nosniff',
        },
      })
    if (edge && !pending) {
      const stored = response.clone()
      stored.headers.set('cache-control', PUBLIC_EDGE_CACHE)
      ctx!.waitUntil(edge.put(cacheRequest, stored))
    }
    return timed(
      request.method === 'HEAD' ? new Response(null, { headers: response.headers }) : response,
      start,
      `index;dur=${pointerMs.toFixed(2)};desc="indexed pointer", refs;dur=0;desc="in pointer", snapshot;dur=${(performance.now() - r2Start).toFixed(2)};desc="R2 parallel fragments", file;dur=0;desc="included in snapshot", score;dur=0;desc="stored HTML", render;dur=0;desc="stitch only"`,
    )
  } catch (error) {
    if ((error as {status?:number}).status === 429) return historyLimited('/'+pointer.repository,(error as {retryAfter?:string}).retryAfter ?? '3600')
    if (!(error as { pending?: boolean }).pending) throw error
    // Keep the account chrome available even before the home projection exists.
    return timed(
      await preparingPage(request, () => rendererShell(env as never), 'Fragments are being prepared; retry shortly'),
      start,
    )
  }
}
