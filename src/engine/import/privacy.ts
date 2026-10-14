/** A metadata ACL fence must not revoke the import that is publishing it.
 * This exception only covers exact-job capabilities and import transport paths.
 */
export async function importCapabilityRead(
  request: Request,
  owner: string,
  repo: string,
  authorize: (owner: string, repo: string, token: string) => Promise<unknown>,
) {
  const path = new URL(request.url).pathname
  if (!/^\/api\/(?:v1\/)?repos\/[^/]+\/[^/]+\/import\/(?:credentials|heartbeat|batch|workflow|finish)$/.test(path) &&
      !/^\/[^/]+\/[^/]+\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.test(path)) return false
  const token = request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? ''
  if (!token.startsWith('gi_')) return false
  try { await authorize(owner, repo, token); return true } catch { return false }
}
