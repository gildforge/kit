import { gitProxy, type GitParams } from '../gitproxy.js'


// Canonical clone URL, same shape as the repo page:
//   https://gild.gg/<owner>/<repo>.git
// This catch-all sits next to the repo page — /<owner>/<repo> renders HTML,
// /<owner>/<repo>.git/<git protocol path> speaks smart HTTP. Anything that
// isn't a git protocol path 404s here so real repo sub-pages can grow later.

const GIT_PATH = /^(info\/refs|git-upload-pack|git-receive-pack|HEAD)$/

function gitParams(params: { owner: string; repo: string; path?: string[] }): GitParams | null {
  if (!params.repo.endsWith('.git')) return null
  const tail = (params.path ?? []).join('/')
  if (!GIT_PATH.test(tail)) return null
  return params
}

async function handle(request: Request, params: Promise<{ owner: string; repo: string; path?: string[] }>) {
  const p = gitParams(await params)
  if (!p) return new Response('not found', { status: 404 })
  return gitProxy(request, p)
}

export async function GET(request: Request, ctx: { params: Promise<{ owner: string; repo: string; path?: string[] }> }) {
  return handle(request, ctx.params)
}
export async function POST(request: Request, ctx: { params: Promise<{ owner: string; repo: string; path?: string[] }> }) {
  return handle(request, ctx.params)
}
