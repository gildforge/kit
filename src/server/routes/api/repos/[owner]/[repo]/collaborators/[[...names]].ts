import { legacy } from '../../../../../../api/legacy.js'
async function handle(
  r: Request,
  c: { params: Promise<{ owner: string; repo: string; names?: string[] }> },
) {
  const { owner, repo, names } = await c.params
  if (r.method === 'GET' && !names?.length)
    return legacy(r, 'collaborators', { owner, repo })
  if (names?.length !== 1) return new Response('Not found', { status: 404 })
  return legacy(
    r,
    r.method === 'PUT' ? 'addCollaborator' : 'removeCollaborator',
    { owner, repo, username: names[0] },
  )
}
export const GET = handle,
  PUT = handle,
  DELETE = handle
