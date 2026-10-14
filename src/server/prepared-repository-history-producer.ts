import type {D1Database} from '@cloudflare/workers-types'
import type {Commit} from '../engine/repo-index-store.js'
import {comparison,type Index} from './api/indexed.js'
import {ApiError} from '../engine/api/errors.js'
import {HISTORY_VERSION,HISTORY_STAGE_LIMIT,HISTORY_STAGE_BYTES,HISTORY_COMPARISON_LIMIT,HISTORY_COMPARISON_BYTES,historyCommitPages,validateHistoryIdentity,validateHistoryCommit,validateHistoryDiff,type HistoryDiff} from './prepared-repository-history-facts.js'

/** Only a producer that observed actual object absence may call this port.
 * A missing/unhydrated source row is never proof of a missing Git object. */
export async function publishPreparedHistoryMissing(db:D1Database,id:string,sha:string){
  validateHistoryIdentity(id,sha)
  await db.prepare(`INSERT INTO prepared_history_commits VALUES (?,?,?,'notfound',NULL)
    ON CONFLICT(id,version,sha) DO NOTHING`).bind(id,HISTORY_VERSION,sha).run()
}
export async function publishPreparedHistoryCommits(db:D1Database,id:string,commits:Commit[]){
  if(commits.length>HISTORY_STAGE_LIMIT||new TextEncoder().encode(JSON.stringify(commits)).length>HISTORY_STAGE_BYTES)throw new Error('Commit fact page exceeds staging bound')
  for(const commit of commits){validateHistoryIdentity(id,commit.hash);validateHistoryCommit(commit)}
  if(!commits.length)return
  const values=commits.map(commit=>JSON.stringify({hash:commit.hash,tree:commit.tree,parents:commit.parents,author_name:commit.author_name,author_email:commit.author_email,time:commit.time,message:commit.message,committer_name:commit.committer_name,committer_email:commit.committer_email,committer_time:commit.committer_time}))
  for(const [index,commit] of commits.entries()){
    const stored=await db.prepare('SELECT state,data FROM prepared_history_commits WHERE id=? AND version=? AND sha=?').bind(id,HISTORY_VERSION,commit.hash).first<{state:string;data:string|null}>()
    if(stored?.state==='ready'&&stored.data!==values[index])throw new Error('Conflicting immutable commit facts')
  }
  await db.batch(commits.map((commit,index)=>db.prepare(`INSERT INTO prepared_history_commits VALUES (?,?,?,'ready',?)
    ON CONFLICT(id,version,sha) DO UPDATE SET state='ready',data=excluded.data WHERE prepared_history_commits.state='notfound'`)
    .bind(id,HISTORY_VERSION,commit.hash,values[index])))
}
/** Stream closed history pages from the immutable producer graph. Native Git
 * author time and SHA ordering match RepoIndex.apiLog exactly. No receipt is
 * created by a page, and already-certified immutable histories cannot mutate. */
export async function stagePreparedRepositoryHistory(db:D1Database,id:string,root:string,commits:Commit[]){
  validateHistoryIdentity(id,root)
  await publishPreparedHistoryCommits(db,id,commits)
  if(!commits.length)return
  const values=commits.map(commit=>JSON.stringify({hash:commit.hash,tree:commit.tree,parents:commit.parents,author_name:commit.author_name,author_email:commit.author_email,time:commit.time,message:commit.message,committer_name:commit.committer_name,committer_email:commit.committer_email,committer_time:commit.committer_time}))
  for(const [index,commit] of commits.entries()){
    const stored=await db.prepare('SELECT state,data FROM prepared_history_commits WHERE id=? AND version=? AND sha=?').bind(id,HISTORY_VERSION,commit.hash).first<{state:string;data:string|null}>()
    if(stored?.state==='ready'&&stored.data!==values[index])throw new Error('Conflicting immutable commit facts')
  }
  await db.batch(commits.map((commit,index)=>db.prepare(`INSERT INTO prepared_history_nodes
    SELECT ?,?,?,sha,json_extract(data,'$.time') FROM prepared_history_commits
    WHERE id=? AND version=? AND sha=? AND state='ready'
      AND NOT EXISTS (SELECT 1 FROM prepared_history_receipts WHERE id=? AND version=? AND root=?)
    ON CONFLICT(id,version,root,sha) DO NOTHING`)
    .bind(id,HISTORY_VERSION,root,id,HISTORY_VERSION,commit.hash,id,HISTORY_VERSION,root)))
}
/** Verify both ancestry closure and reachable membership in SQLite BEFORE
 * issuing the complete receipt. Count alone cannot certify an orphan/subset. */
export async function publishPreparedRepositoryHistoryReceipt(db:D1Database,id:string,root:string,total:number){
  validateHistoryIdentity(id,root)
  if(!Number.isSafeInteger(total)||total<1)throw new Error('A Git commit history includes at least its real root')
  const result=await db.prepare(`WITH RECURSIVE reachable(sha) AS (
    SELECT ? UNION SELECT parent.value FROM reachable r
    JOIN prepared_history_commits c ON c.sha=r.sha AND c.id=? AND c.version=? AND c.state='ready',json_each(c.data,'$.parents') parent
  ) INSERT INTO prepared_history_receipts SELECT ?,?,?,?
    WHERE (SELECT count(*) FROM prepared_history_nodes WHERE id=? AND version=? AND root=?)=?
    AND (SELECT count(*) FROM reachable)=?
    AND NOT EXISTS (SELECT 1 FROM reachable r LEFT JOIN prepared_history_nodes n
      ON n.sha=r.sha AND n.id=? AND n.version=? AND n.root=? WHERE n.sha IS NULL)
    AND NOT EXISTS (SELECT 1 FROM prepared_history_nodes n LEFT JOIN prepared_history_commits c
      ON c.id=n.id AND c.version=n.version AND c.sha=n.sha AND c.state='ready'
      WHERE n.id=? AND n.version=? AND n.root=? AND c.sha IS NULL)
    ON CONFLICT(id,version,root) DO NOTHING`)
    .bind(root,id,HISTORY_VERSION,id,HISTORY_VERSION,root,total,id,HISTORY_VERSION,root,total,total,
      id,HISTORY_VERSION,root,id,HISTORY_VERSION,root).run()
  return Number(result.meta.changes??0)>0
}
export async function publishPreparedRepositoryHistory(db:D1Database,id:string,root:string,commits:Commit[],complete:boolean){
  if(!complete)throw new Error('History source is incomplete')
  const seen=new Set<string>()
  for(const c of commits){validateHistoryCommit(c);if(seen.has(c.hash))throw new Error('Duplicate history membership');seen.add(c.hash)}
  for(const page of historyCommitPages(commits))await stagePreparedRepositoryHistory(db,id,root,page)
  return publishPreparedRepositoryHistoryReceipt(db,id,root,commits.length)
}
export async function publishPreparedHistoryDetails(db:D1Database,id:string,commit:Commit,diff:HistoryDiff){
  validateHistoryIdentity(id,commit.hash);validateHistoryCommit(commit);validateHistoryDiff(diff)
  if(diff.to!==commit.hash||diff.from!==(commit.parents[0]??null))throw new Error('Commit details require its actual first-parent diff')
  await publishPreparedHistoryCommits(db,id,[commit])
  const stored=await db.prepare('SELECT parent,data FROM prepared_history_details WHERE id=? AND version=? AND sha=?').bind(id,HISTORY_VERSION,commit.hash).first<{parent:string|null;data:string}>()
  if(stored&&(stored.parent!==diff.from||stored.data!==JSON.stringify(diff.files)))throw new Error('Conflicting immutable commit file facts')
  await db.prepare(`INSERT INTO prepared_history_details VALUES (?,?,?,?,?) ON CONFLICT(id,version,sha) DO NOTHING`)
    .bind(id,HISTORY_VERSION,commit.hash,diff.from,JSON.stringify(diff.files)).run()
}
/** Closed, hydrated graph observation from the producer only. Reuse the exact
 * legacy comparison algorithm; GETs only read its recorded result and page. */
export async function publishPreparedHistoryComparison(db:D1Database,id:string,base:string,head:string,graph:Commit[],diff?:HistoryDiff){
  validateHistoryIdentity(id,base);validateHistoryIdentity(id,head)
  if(graph.length>HISTORY_COMPARISON_LIMIT||new TextEncoder().encode(JSON.stringify(graph)).length>HISTORY_COMPARISON_BYTES)throw new Error('Comparison graph exceeds preparation bound')
  const commits=new Map<string,Commit>()
  for(const commit of graph){validateHistoryCommit(commit);if(commits.has(commit.hash))throw new Error('Duplicate comparison graph commit');commits.set(commit.hash,commit)}
  if(!commits.has(base)||!commits.has(head)||graph.some(c=>c.parents.some(p=>!commits.has(p))))throw new Error('Comparison graph is not closed')
  const adapter={ensureHistory:async()=>true,commit:async(sha:string)=>commits.get(sha)??null,hydrate:async()=>{throw new Error('Comparison source is not hydrated')}} as unknown as Index
  for(const page of historyCommitPages(graph))await publishPreparedHistoryCommits(db,id,page)
  let compared:Awaited<ReturnType<typeof comparison>>
  try{compared=await comparison(adapter,base,head)}catch(error){
    if(!(error instanceof ApiError)||error.status!==409)throw error
    await db.prepare(`INSERT INTO prepared_history_comparisons VALUES (?,?,?,?,'unrelated',NULL) ON CONFLICT(id,version,base,head) DO NOTHING`)
      .bind(id,HISTORY_VERSION,base,head).run()
    return {state:'unrelated' as const}
  }
  if(!diff)throw new Error('Comparison requires the actual merge-base-to-head diff')
  validateHistoryDiff(diff)
  if(diff.from!==compared.mergeBase||diff.to!==head)throw new Error('Comparison diff does not match observed merge base/head')
  // Membership is paged outside the GET. No partial page publishes a receipt.
  for(let i=0;i<compared.commits.length;i+=HISTORY_STAGE_LIMIT){
    await db.batch(compared.commits.slice(i,i+HISTORY_STAGE_LIMIT).map((commit,n)=>db.prepare(`INSERT INTO prepared_history_comparison_nodes SELECT ?,?,?,?,?,?
      WHERE NOT EXISTS (SELECT 1 FROM prepared_history_comparisons WHERE id=? AND version=? AND base=? AND head=?)
      ON CONFLICT(id,version,base,head,position) DO UPDATE SET sha=excluded.sha`)
      .bind(id,HISTORY_VERSION,base,head,i+n,commit.hash,id,HISTORY_VERSION,base,head)))
  }
  const result={mergeBase:compared.mergeBase,ahead:compared.ahead,behind:compared.behind,files:diff.files}
  const publication=await db.prepare(`INSERT INTO prepared_history_comparisons SELECT ?,?,?,?,'ready',?
    WHERE (SELECT count(*) FROM prepared_history_comparison_nodes WHERE id=? AND version=? AND base=? AND head=?)=?
    ON CONFLICT(id,version,base,head) DO NOTHING`).bind(id,HISTORY_VERSION,base,head,JSON.stringify(result),id,HISTORY_VERSION,base,head,compared.ahead).run()
  if(!Number(publication.meta.changes??0)){
    const stored=await db.prepare('SELECT state,data FROM prepared_history_comparisons WHERE id=? AND version=? AND base=? AND head=?').bind(id,HISTORY_VERSION,base,head).first<{state:string;data:string|null}>()
    if(stored?.state!=='ready'||stored.data!==JSON.stringify(result))throw new Error('Comparison membership or immutable facts are inconsistent')
  }
  return {state:'ready' as const,...result}
}
