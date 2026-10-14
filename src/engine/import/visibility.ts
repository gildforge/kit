import type { FenceDB } from './fence.js'
// Shared by standalone ref readers and the existing ACL read in gitProxy.
export const internalPrefixQuery = "SELECT internal_prefix FROM repo_imports WHERE lower(repository)=lower(?) AND state IN ('queued','running','mirroring','failed')"
/** The import owns only its collision-free PR namespace, never source branches. */
export async function internalPrefix(db:FenceDB, repository:string) {
  const row=await db.prepare(internalPrefixQuery).bind(repository).first<{internal_prefix:string}>()
  return row?.internal_prefix ?? undefined
}
export const visibleImportRef=(name:string,prefix?:string)=>!prefix || !name.startsWith(prefix+'/')
