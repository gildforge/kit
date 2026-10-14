import { legacy } from '../../../../api/legacy.js'
async function handle(r: Request, c: { params: Promise<{ ids?: string[] }> }) {
  const { ids } = await c.params
  if (r.method === 'GET' && !ids?.length)
    return legacy(r, 'repositoryInvitations', {})
  if (ids?.length !== 1) return new Response('Not found', { status: 404 })
  return legacy(
    r,
    r.method === 'PATCH'
      ? 'acceptRepositoryInvitation'
      : 'declineRepositoryInvitation',
    { id: ids[0] },
  )
}
export const GET = handle,
  PATCH = handle,
  DELETE = handle
