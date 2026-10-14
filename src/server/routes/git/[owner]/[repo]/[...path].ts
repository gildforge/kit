import { gitProxy, type GitParams } from '../../../../gitproxy.js'


// Legacy clone URL shape (https://gild.gg/git/<owner>/<repo>.git) — kept so
// existing clones and remotes keep working. The canonical URL is
// https://gild.gg/<owner>/<repo>.git.

export async function GET(request: Request, { params }: { params: Promise<GitParams> }) {
  return gitProxy(request, await params)
}
export async function POST(request: Request, { params }: { params: Promise<GitParams> }) {
  return gitProxy(request, await params)
}
