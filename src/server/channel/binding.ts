import type { RepoChannel } from './do.js'
export type Channel = { [K in 'participants'|'snapshot'|'page'|'post'|'online'|'system'|'note'|'fetch'|'states'|'accessChanged']: (...args: Parameters<RepoChannel[K]>) => Promise<Awaited<ReturnType<RepoChannel[K]>>> }
export interface ChannelBindings { REPO_CHANNEL?: { idFromName(name: string): unknown; get(id: unknown): Channel } }
export function channelFrom(env: ChannelBindings, id: string) {
  if (!env.REPO_CHANNEL) throw Error('REPO_CHANNEL binding is required')
  return env.REPO_CHANNEL.get(env.REPO_CHANNEL.idFromName(id))
}

/** Access publication is authoritative. Notification failures must not turn a
 * successful Git/ACL write into a failed write; the five-second timer backs it.
 */
export async function channelAccessChanged(env: ChannelBindings, id: string) {
  if (!env.REPO_CHANNEL) return
  try { await channelFrom(env,id).accessChanged() } catch { /* Timer revalidates. */ }
}
