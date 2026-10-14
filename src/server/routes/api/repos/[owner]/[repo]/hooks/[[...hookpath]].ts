import { legacy } from '../../../../../../api/legacy.js'
import { match } from '../../../../../../api/dispatch.js'
async function handle(request: Request) {
  const pathname = new URL(request.url).pathname.replace(/^\/api\//, '/'),
    found = match(request.method, pathname)
  if (!found || found.route.phase !== 'B')
    return Response.json({ message: 'Not found' }, { status: 404 })
  return legacy(request, found.route.id, found.params)
}
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE }
