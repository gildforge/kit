import { legacy } from '../../../../../api/legacy.js'
import type { Operation } from '../../../../../../engine/api/contract.js'
async function handle(
  r: Request,
  params: Promise<{ owner: string; repo: string; operation: string }>,
) {
  const p = await params
  const op: Record<string, Operation> = {
    'GET:rename': 'renameStatusRepo',
    'POST:rename': 'renameRepo',
    'PUT:archive': 'archiveRepo',
    'POST:restore': 'restoreRepo',
  }
  const id = op[r.method + ':' + p.operation]
  return id
    ? legacy(r, id, { owner: p.owner, repo: p.repo })
    : new Response(null, { status: 404 })
}
export function POST(
  r: Request,
  {
    params,
  }: { params: Promise<{ owner: string; repo: string; operation: string }> },
) {
  return handle(r, params)
}
export const PUT = POST

export const GET = POST
