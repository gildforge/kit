import { defaultEdge, type EdgeCache, type EdgeContext } from './fragments/edge.js'
import { viewerShell } from '../presentation/viewer-shell.js'

/** A browser navigation to a page (never an API, Git or asset read). Only
 * these get HTML status pages; machines keep the short text bodies. */
export function htmlNavigation(request: Request) {
  const path = new URL(request.url).pathname,
    first = path.split('/')[1] ?? ''
  return ['GET', 'HEAD'].includes(request.method) &&
    /\btext\/html\b/.test(request.headers.get('accept') ?? '') &&
    !['api', 'git', 'pf', 'f', 'gild-fragments', '_next'].includes(first) &&
    !/(?:\.git|\/info\/refs|\/git-(?:upload|receive)-pack)$/.test(path)
}

/** Next's built 404 document (app/not-found.tsx), prerendered per build. */
export const MISSING_DOCUMENT = '/_not-found'

/** Suggested delay before explicitly checking a Pending artifact again. */
export const PREPARING_REFRESH_S = 3

/** The site's own 404 document (site header, the Missing message and
 * footer), rendered anonymously once per build. Missing and private
 * repositories, and missing owners, all receive these identical bytes.
 * Non-browser reads keep the short text 404. */
export async function missingPage(
  request: Request,
  build: string,
  render: (request: Request) => Promise<Response>,
  ctx?: EdgeContext,
  edge: EdgeCache | undefined = defaultEdge(),
) {
  if (!htmlNavigation(request))
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'private, no-store' } })
  const key = new Request(new URL('/__gild-missing/' + build, request.url))
  let body = await (await edge?.match(key))?.text()
  if (body === undefined) {
    // No cookie or authorization: the 404 never depends on the viewer. Only a
    // document whose chrome rendered on the server (through the footer) is kept.
    const rendered = await render(new Request(new URL(MISSING_DOCUMENT, request.url), { headers: { accept: 'text/html' } }))
    const html = await rendered.text()
    if (!rendered.headers.get('content-type')?.includes('text/html') || rendered.headers.has('set-cookie') || !html.includes('</footer>') || html.includes('NEXT_HTTP_ERROR_FALLBACK'))
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'private, no-store' } })
    body = html
    if (edge && ctx) ctx.waitUntil(edge.put(key, new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' },
    })).catch(() => {}))
  }
  return new Response(request.method === 'HEAD' ? null : body, {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function escapeText(value: string) {
  return value.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** Message in the same layout as the site's 404 (components/Missing.tsx). */
function statusContent(code: number, title: string, text: string, link: string) {
  return `<div style="padding:72px 0;max-width:560px" role="status"><p class="mono-dim" style="margin:0">${code}</p>` +
    `<h1 style="font-size:26px;margin:6px 0 10px">${escapeText(title)}</h1>` +
    `<p style="color:var(--ink-soft);font-size:15px;margin:0 0 18px">${escapeText(text)}</p>${link}</div>`
}

// Used only when the renderer's shell is unavailable: still themed light/dark
// (palette values from app/globals.css).
const FALLBACK_SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>gild</title>` +
  `<script>(function(){try{var t=localStorage.getItem('gild.theme')||'dark';document.documentElement.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t==='light'?'light':'dark';}catch(e){document.documentElement.dataset.theme='dark';}})()</script>` +
  `<style>html{background:#fafaf8;color:#17181b;--ink-soft:#4a4d55;--ink-faint:#71747a;--accent:#9a6b0c}html[data-theme=dark]{background:#0b0c0e;color:#eceae4;--ink-soft:#b9b6ae;--ink-faint:#8c897f;--accent:#e2b54a}body{margin:0;font-family:system-ui,sans-serif}main{padding:0 24px 24px}.mono-dim{color:var(--ink-faint);font-size:12px;font-family:ui-monospace,monospace}</style>` +
  `</head><body><main><div data-fragment-root=""><!--gild-content--></div></main></body></html>`

/** A themed page in the site chrome. `shell` is the renderer's stored site
 * shell (header, footer, theme); a failure to read it falls back to a
 * minimal themed document, never plain text. */
async function shellPage(request: Request, shell: () => Promise<string | null>, content: string, head: string, status: number, headers: Record<string, string>) {
  let html: string | null = null
  try { html = await shell() } catch { html = null }
  if (!html?.includes('<!--gild-content-->')) html = FALLBACK_SHELL
  html = viewerShell(html, new URL(request.url), false)
    .replace('</head>', head + '</head>')
    .replace('<!--gild-content-->', content)
  return new Response(request.method === 'HEAD' ? null : html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  })
}

/** A repository whose index or fragments are still being built. Both browser
 * and machine responses complete promptly with an explicit Pending state. */
export function preparingPage(request: Request, shell: () => Promise<string | null>, text = 'Repository is being prepared; retry shortly') {
  const headers = { 'retry-after': String(PREPARING_REFRESH_S), 'x-gild-state': 'pending' }
  if (!htmlNavigation(request))
    return Promise.resolve(Response.json({ state: 'pending', retryAfter: PREPARING_REFRESH_S }, { status: 202, headers: { 'cache-control': 'private, no-store', ...headers } }))
  return shellPage(request, shell,
    '<section data-artifact-pending="" role="status">' + statusContent(202, 'Pending', 'This view is being prepared in the background.', '<a href="" data-pending-retry="" style="color:var(--accent)">Check again</a>') + '</section>',
    '', 200, headers)
}

/** Errors that mean "not ready yet": index rehydration, cold fragments and
 * cold pointers. Everything else is a bug and must not look like indexing. */
export function stillPreparing(error: unknown) {
  const { status, message } = (error ?? {}) as { status?: number; message?: string }
  return status === 503 || /\bindexing\b|^(?:Pointer|Fragment) unavailable$/.test(message ?? '')
}

/** The worker's last resort for an exception from the routing chain. */
export async function routingFailure(request: Request, error: unknown, shell: () => Promise<string | null>) {
  if (stillPreparing(error)) return preparingPage(request, shell)
  console.error('Request failed', request.method, new URL(request.url).pathname, error)
  if (!htmlNavigation(request))
    return new Response('Internal error', { status: 500, headers: { 'cache-control': 'private, no-store' } })
  return shellPage(request, shell,
    statusContent(500, 'Something went wrong', 'The error has been logged. Try again in a moment.', '<a href="/" style="color:var(--accent)">Back to gild</a>'),
    '', 500, {})
}

/** The renderer's current site shell, as stored in R2 by gild-render. */
export async function rendererShell(env: {
  GILD_RENDER: { fetch(url: string, init?: RequestInit): Promise<{ ok: boolean; json(): Promise<unknown> }> }
  FRAGMENTS: { get(key: string): Promise<{ body: unknown; httpMetadata?: { contentEncoding?: string } } | null> }
}) {
  // Read the producer's published address; never ask it to render or persist
  // assets while serving a status page.
  const response = await env.GILD_RENDER.fetch('https://gild-render/version', {
    method: 'POST', signal: AbortSignal.timeout(2000),
  })
  if (!response.ok) return null
  const { shell, version } = await response.json() as { shell?: string; version?: string }
  const key = shell && version ? `f/${version}/shell/${shell}` : null
  const object = key ? await env.FRAGMENTS.get(key) : null
  if (!object) return null
  const body = object.body as ReadableStream
  return new Response(object.httpMetadata?.contentEncoding === 'gzip' ? body.pipeThrough(new DecompressionStream('gzip')) : body).text()
}
