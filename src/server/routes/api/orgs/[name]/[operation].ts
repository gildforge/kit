import { legacy } from '../../../../api/legacy.js'
import type { Operation } from '../../../../../engine/api/contract.js'
async function handle(
  r: Request,
  params: Promise<{ name: string; operation: string }>,
) {
  const p = await params
  const op: Record<string, Operation> = {
    'GET:profile': 'orgProfile',
    'PATCH:profile': 'updateOrgProfile',
    'PUT:picture': 'updateOrgPicture',
    'DELETE:picture': 'deleteOrgPicture',
    'GET:rename': 'renameStatusOrg',
    'POST:rename': 'renameOrg',
    'PUT:archive': 'archiveOrg',
    'POST:restore': 'restoreOrg',
  }
  const id = op[r.method + ':' + p.operation]
  return id
    ? legacy(r, id, { org: p.name })
    : new Response(null, { status: 404 })
}
export function GET(
  r: Request,
  { params }: { params: Promise<{ name: string; operation: string }> },
) {
  return handle(r, params)
}
export const PATCH = GET
export const PUT = GET
export const POST = GET

export const DELETE = GET
