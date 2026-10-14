import { AsyncLocalStorage } from 'node:async_hooks'
import type { MemFS } from './memfs.js'

// Only the first metadata mutation in an API operation receives this identity;
// follow-up Actions/event jobs must not accidentally reuse its receipt.
export interface MetadataOperation { id: string; used: boolean; snapshot?: (result: unknown, fs: MemFS) => Promise<unknown> }
export const recoverableMetadataRoutes = new Set(['createIssue', 'createPull', 'createIssueComment', 'createPullComment'])
const operations = new AsyncLocalStorage<MetadataOperation>()
export const metadataOperationPath = (id: string) => `.gild/operations/${id}.json`
export function withMetadataOperation<T>(id: string | undefined, work: () => Promise<T>): Promise<T> {
  return id ? operations.run({ id, used: false }, work) : work()
}
export function takeMetadataOperation() {
  const operation = operations.getStore()
  if (!operation || operation.used) return undefined
  operation.used = true
  return operation.id
}
/** Creation facts are captured before the Git commit, never on a retry read. */
export function setMetadataOperationSnapshot(snapshot: NonNullable<MetadataOperation['snapshot']>) {
  const operation = operations.getStore()
  if (operation) operation.snapshot = snapshot
}
export async function metadataOperationSnapshot(result: unknown, fs: MemFS) {
  const snapshot = operations.getStore()?.snapshot
  return snapshot ? { data: await snapshot(result, fs) } : {}
}
