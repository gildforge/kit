import type {Commit} from '../engine/repo-index-store.js'
import type {FileDiff} from './compare.js'
export const HISTORY_VERSION='history:v1'
export const HISTORY_STAGE_LIMIT=64
export const HISTORY_COMPARISON_LIMIT=10000
export const HISTORY_FILE_LIMIT=300
export const HISTORY_FACT_BYTES=1024*1024
export const HISTORY_PAGE_BYTES=2*1024*1024
export const HISTORY_STAGE_BYTES=2*1024*1024
export const HISTORY_COMPARISON_BYTES=16*1024*1024
export interface HydratedHistoryCommit extends Commit {
  committer_name:string;committer_email:string;committer_time:number
}
export interface HistoryFile extends FileDiff {sha:string}
export interface HistoryDiff {from:string|null;to:string;files:HistoryFile[];complete:boolean}
export function validateHistoryIdentity(id:string,sha:string){
  if(typeof id!=='string'||!id||typeof sha!=='string'||!/^[a-f0-9]{40}$/.test(sha))throw new Error('Invalid repository history identity')
}
export function validateHistoryCommit(c:Commit):asserts c is HydratedHistoryCommit {
  validateHistoryIdentity('commit',c?.hash);validateHistoryIdentity('tree',c.tree)
  if(!Array.isArray(c.parents)||c.parents.length>64||new Set(c.parents).size!==c.parents.length||c.parents.includes(c.hash)
    ||c.parents.some(p=>!/^[a-f0-9]{40}$/.test(p))||typeof c.author_name!=='string'||typeof c.author_email!=='string'
    ||typeof c.message!=='string'||typeof c.committer_name!=='string'||typeof c.committer_email!=='string'
    ||![c.time,c.committer_time].every(t=>Number.isSafeInteger(t)&&Math.abs(t!)<=8640000000000))
    throw new Error('History commit is not hydrated or valid')
  if(new TextEncoder().encode(JSON.stringify(c)).length>HISTORY_FACT_BYTES)throw new Error('Commit metadata exceeds prepared history bound')
}
export function validateHistoryDiff(diff:HistoryDiff){
  validateHistoryIdentity('diff',diff.to)
  if(diff.from!==null)validateHistoryIdentity('diff base',diff.from)
  if(diff.from===diff.to&&diff.files.length)throw new Error('Identical commit diff cannot contain changes')
  if(!diff.complete)throw new Error('Diff source is incomplete')
  if(!Array.isArray(diff.files)||diff.files.length>HISTORY_FILE_LIMIT)throw new Error('Prepared diff exceeds file bound')
  const paths=new Set<string>()
  for(const file of diff.files){
    if(!file||typeof file.path!=='string'||!file.path||file.path.length>4096||paths.has(file.path)||!['added','removed','modified'].includes(file.status)
      ||!Number.isSafeInteger(file.additions)||file.additions<0||!Number.isSafeInteger(file.deletions)||file.deletions<0
      ||!Array.isArray(file.hunks)||file.hunks.some(h=>!Number.isSafeInteger(h.oldStart)||h.oldStart<0||!Number.isSafeInteger(h.newStart)||h.newStart<0
        ||!Array.isArray(h.lines)||h.lines.some(line=>typeof line!=='string')))
      throw new Error('Invalid observed history file diff')
    validateHistoryIdentity('blob',file.sha);paths.add(file.path)
  }
  for(const sum of [diff.files.reduce((n,f)=>n+f.additions,0),diff.files.reduce((n,f)=>n+f.deletions,0),diff.files.reduce((n,f)=>n+f.additions+f.deletions,0)])
    if(!Number.isSafeInteger(sum))throw new Error('Observed diff statistics exceed safe integers')
  if(new TextEncoder().encode(JSON.stringify(diff)).length>HISTORY_FACT_BYTES)throw new Error('Prepared diff exceeds byte bound')
}


/** Keep producer D1 batches bounded by both row count and actual metadata
 * bytes. A long but complete history streams pages instead of raising memory
 * proportional to its ancestry while staging. */
export function* historyCommitPages(commits:Commit[]){
  let page:Commit[]=[],bytes=0
  for(const commit of commits){
    const size=new TextEncoder().encode(JSON.stringify(commit)).length
    if(page.length&&(page.length===HISTORY_STAGE_LIMIT||bytes+size>HISTORY_STAGE_BYTES)){yield page;page=[];bytes=0}
    page.push(commit);bytes+=size
  }
  if(page.length)yield page
}
