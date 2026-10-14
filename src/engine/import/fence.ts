/** A source token means a private source: never publish it unless asked to. */
export const destinationPrivate = (b: { private?: boolean; source_token?: string }) =>
  b.private ?? !!b.source_token

export interface FenceDB {
  prepare(q: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } }
}
/** An import or mirror owns the refs until cutover: its next sync would
 * force-push over anything pushed meanwhile, so user pushes are refused. */
export async function importOwnsRefs(db: FenceDB | undefined, repository: string) {
  if (!db) return false
  const row = await db
    .prepare(
      "SELECT state FROM repo_imports WHERE lower(repository)=lower(?) AND state IN ('queued','running','mirroring','failed')",
    )
    .bind(repository)
    .first<{ state: string }>()
  return !!row
}
