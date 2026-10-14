// Cookies prove identity, not intent. Unsafe browser calls must carry their
// browser-supplied Origin; CLI proof/token calls have their own authentication.
import { requestOrigin } from './browser-proof.js'
export function csrfSafe(request: Request, options: { trustWorkerOrigin?: boolean } = {}) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true
  const source = request.headers.get('origin')
  return (
    source !== null &&
    source === (options.trustWorkerOrigin ? requestOrigin(request) : new URL(request.url).origin) &&
    [null, 'same-origin', 'none'].includes(request.headers.get('sec-fetch-site'))
  )
}
