import { mayRead, type ReadServices } from '../repo-read.js'
import type { Receipt } from '../../engine/sessions-contract.js'
export async function readSessionReceipts(s: Omit<ReadServices, 'index'> & {index(owner: string, repo: string): Promise<({metaFile(path: string): Promise<string|null>; sessionList(target: string, limit: number, offset: number): Promise<{receipts: Receipt[]}>})|null>}, owner: string, repo: string, target: string, viewer: string | null) {
  if (!viewer || !await mayRead(s, owner, repo, viewer)) return []
  const index = await s.index(owner, repo)
  return index ? (await index.sessionList(target, 100, 0)).receipts : []
}
