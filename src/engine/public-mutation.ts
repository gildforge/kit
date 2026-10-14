import { matchRequest } from './api/routing.js'

// These transport and viewer operations don't change public presentation.
// In particular, runner polls must not invalidate grants or enqueue page work.
const transportOperations = new Set([
  'importClaim', 'importUserPoll', 'importOrgPoll', 'importCredentials', 'importHeartbeat',
  'orgPoolPoll', 'userPoolPoll', 'runnerPoll', 'runnerHeartbeat', 'runnerLogs', 'runnerStep',
  'orgPoolRegistration', 'userPoolRegistration', 'actionRegistration',
  'createToken', 'deleteToken', 'actionPutSecret', 'actionDeleteSecret',
  'repoPingHook', 'orgPingHook', 'repoRedeliverHook', 'orgRedeliverHook',
])

export function publicMutation(request: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return false
  const path = new URL(request.url).pathname
  // Bootstrap auth is outside the versioned route table. These exact writes
  // change private challenge/session state, never public content or ACLs.
  // Do not exclude the whole auth/claim namespace: completed claims create
  // public owners, and future revocation/content routes need invalidation.
  if (request.method === 'POST' && /^\/api\/auth\/(challenge|answer|signout)\/?$/.test(path)) return false
  if (path.endsWith('/git-upload-pack')) return false
  const operation = matchRequest(request.method, path)
  // Unknown writes retain conservative invalidation, including receive-pack.
  return !operation || !transportOperations.has(operation.route.id)
}
