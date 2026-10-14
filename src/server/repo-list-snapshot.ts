export type { ListingFacts, ListingSnapshot } from '../engine/types.js'
import type { ListingFacts, ListingSnapshot } from '../engine/types.js'
import type { IndexStore } from '../engine/repo-index-store.js'
import type { MetaIndex } from './metastore.js'
import { commitWeeks, licenseId } from '../engine/repo-summary.js'


/** Runs beside the SQLite index, never via per-field RPCs. Completed code and
 * metadata facts are computed once under their immutable tips. A refresh
 * leaves the published refs/ACL intact; incomplete history is never cached. */
export function listingSnapshot(index: IndexStore): ListingSnapshot | null {
  if (index.setting('ready') !== '1') return null
  const branch = index.setting('defaultBranch') ?? 'main'
  const tip =
    index.refs().find((r) => r.kind === 'branch' && r.name === branch)?.hash ??
    null
  const meta = index.setting('meta') || null
  const metadataKey = `repo-list:meta:v1:${meta ?? 'empty'}`
  let metadata = index.view(metadataKey) as Pick<
    ListingSnapshot,
    'acl' | 'issues' | 'pulls'
  > | null
  if (!metadata) {
    const items = JSON.parse(
      index.metaFile('.gild/index.json') ?? '{"issues":[],"pulls":[]}',
    ) as MetaIndex
    metadata = {
      acl: JSON.parse(index.metaFile('.gild/acl.json') ?? '{}'),
      issues: items.issues.filter((i) => i.state === 'open').length,
      pulls: items.pulls.filter((p) => p.state === 'open').length,
    }
    index.view(metadataKey, metadata)
  }
  let facts = tip
    ? (index.view(`repo-list:code:v2:${tip}`) as ListingFacts | null)
    : null
  const commit = tip ? index.commit(tip) : null
  if (!facts && tip && commit && index.historyReady(tip)) {
    const langs = index.languages(commit.tree),
      tree = index.tree(commit.tree)
    if (langs && tree) {
      let license: string | null = null,
        complete = true
      for (const e of tree.filter(
        (e) =>
          e.type === 'blob' && /^(license|copying)(?:[.-].*)?$/i.test(e.name),
      )) {
        const file = index.blobText(e.child)
        if (!file) {
          complete = false
          break
        }
        if (file.kind === 'text') license ??= licenseId(file.text)
      }
      if (complete) {
        // Dates only: don't re-read every commit and its extras across RPCs.
        const dates = index
          .rows<{ time: number }>(
            'SELECT coalesce(e.committer_time,c.time) AS time FROM api_history_nodes n JOIN commits c ON c.hash=n.hash LEFT JOIN commit_extra e ON e.hash=c.hash WHERE n.root=?',
            tip,
          )
          .map((r) => r.time)
        facts = {
          language: langs[0] ?? null,
          license,
          updated: (commit.committer_time ?? commit.time) * 1000,
          weeks: commitWeeks(dates),
        }
        index.view(`repo-list:code:v2:${tip}`, facts)
      }
    }
  }
  if (facts) {
    index.setting(`repo-list:last:${branch}`, JSON.stringify(facts))
    index.setting(`repo-list:last-tip:${branch}`, tip!)
  }
  // Serve the last complete code summary while this tip's history fills in.
  // The current published ACL/counts always travel with it, never old ACLs.
  const last = index.setting(`repo-list:last:${branch}`)
  return {
    note:index.setting('fragments:score-note')||null,
    tip,
    meta,
    ...metadata,
    facts: facts ?? (tip && last ? (JSON.parse(last) as ListingFacts) : null),
    factsTip: facts ? tip : tip && last ? index.setting(`repo-list:last-tip:${branch}`) : null,
    updated: commit ? (commit.committer_time ?? commit.time) * 1000 : null,
  }
}
