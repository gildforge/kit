import type {D1Database} from '@cloudflare/workers-types'
import {ApiError} from '../engine/api/errors.js'
import {routes,type Output} from '../engine/api/contract.js'
import {apiURL,commitShape,origin,repoPath} from './api/shapes.js'
import {paginate,paginationOffset,type Context,type Result} from './api/dispatch.js'
import {SHA,refHash} from '../engine/api/ref-resolution.js'
import {PreparedReadModels,PreparationPending,type PreparedRepositoryAccess} from './prepared-read-models.js'
import {HISTORY_VERSION,HISTORY_PAGE_BYTES,type HydratedHistoryCommit,type HistoryFile} from './prepared-repository-history-facts.js'
const output=(id:'commits'|'commit'|'compare',value:unknown)=>routes.find(r=>r.id===id)!.output.parse(value)
/** Exact legacy URL/patch/stats fields, made exclusively from observed diff
 * facts and actual blob SHA. Never load a tree/blob or invent a missing SHA. */
function fileShape(c:Context,files:HistoryFile[],tip:string):Output<'commit'>['files']{
  return files.map(f=>({sha:f.sha,filename:f.path,status:f.status,additions:f.additions,deletions:f.deletions,changes:f.additions+f.deletions,
    ...(f.hunks.length?{patch:f.hunks.map(h=>`@@ -${h.oldStart} +${h.newStart} @@\n${h.lines.join('\n')}`).join('\n')}:{}),
    blob_url:apiURL(c,`${repoPath(c)}/contents/${f.path}?ref=${tip}`),raw_url:apiURL(c,`${repoPath(c)}/contents/${f.path}?ref=${tip}`),contents_url:apiURL(c,`${repoPath(c)}/contents/${f.path}`)}))
}
export class PreparedRepositoryHistory {
  private readonly db:D1Database
  private readonly models:PreparedReadModels
  constructor(db:D1Database,models=new PreparedReadModels(db)){this.db=db;this.models=models}
  private async record(id:string,sha:string){
    const row=await this.db.prepare('SELECT state,data FROM prepared_history_commits WHERE id=? AND version=? AND sha=?').bind(id,HISTORY_VERSION,sha).first<{state:string;data:string|null}>()
    if(!row)throw new PreparationPending()
    if(row.state==='notfound')throw new ApiError(404,'Commit not found')
    if(!row.data)throw new PreparationPending()
    return JSON.parse(row.data) as HydratedHistoryCommit
  }
  async read(c:Context,authorized?:PreparedRepositoryAccess):Promise<Result>{
    const access=authorized??await this.models.repositoryAccess(c.principal,c.params.owner,c.params.repo)
    const scoped={...c,params:{...c.params,owner:access.owner,repo:access.repo}}
    const names=c.route.id==='commits'?[c.query.sha]:c.route.id==='commit'?[c.params.sha]:c.route.id==='compare'?[c.params.base,c.params.head]:[]
    if(!names.length)throw new ApiError(404,'Unsupported prepared history operation')
    const refs=names.every(name=>name&&SHA.test(name))?null:await this.models.repositoryRefs(c.principal,access.owner,access.repo,access)
    const hashes=names.map(name=>{const hash=name&&SHA.test(name)?name:refHash(refs!.refs,refs!.defaultBranch,name);if(!hash)throw new ApiError(404,'Ref not found');return hash})
    const immutable=names.every(name=>name&&SHA.test(name))
    if(c.route.id==='commits'){
      const root=hashes[0];await this.record(access.id,root)
      const receipt=await this.db.prepare('SELECT total FROM prepared_history_receipts WHERE id=? AND version=? AND root=?').bind(access.id,HISTORY_VERSION,root).first<{total:number}>()
      if(!receipt)throw new PreparationPending()
      const limit=c.query.per_page??30,offset=paginationOffset(c)
      if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ApiError(422,'Invalid history page size')
      const rows=(await this.db.prepare(`WITH page AS (SELECT c.data,n.time,n.sha FROM prepared_history_nodes n
        JOIN prepared_history_commits c ON c.id=n.id AND c.version=n.version AND c.sha=n.sha AND c.state='ready'
        WHERE n.id=? AND n.version=? AND n.root=? ORDER BY n.time DESC,n.sha LIMIT ? OFFSET ?)
        SELECT CASE WHEN sum(length(CAST(data AS BLOB))) OVER (ORDER BY time DESC,sha)<=? THEN data ELSE NULL END AS data FROM page ORDER BY time DESC,sha`)
        .bind(access.id,HISTORY_VERSION,root,limit,offset,HISTORY_PAGE_BYTES).all<{data:string|null}>()).results
      if(rows.some(r=>r.data===null)||rows.length!==Math.max(0,Math.min(limit,receipt.total-offset)))throw new PreparationPending()
      const page=paginate(rows.map(row=>commitShape(scoped,JSON.parse(row.data!))),c,receipt.total,true)
      return {data:output('commits',page.data),headers:page.headers,immutable,noStore:access.private}
    }
    if(c.route.id==='commit'){
      const commit=await this.record(access.id,hashes[0])
      const details=await this.db.prepare('SELECT parent,data FROM prepared_history_details WHERE id=? AND version=? AND sha=?').bind(access.id,HISTORY_VERSION,hashes[0]).first<{parent:string|null;data:string}>()
      if(!details||details.parent!==(commit.parents[0]??null))throw new PreparationPending()
      const files=fileShape(scoped,JSON.parse(details.data),commit.hash)
      return {data:output('commit',{...commitShape(scoped,commit),files,stats:{additions:files.reduce((n,f)=>n+f.additions,0),deletions:files.reduce((n,f)=>n+f.deletions,0),total:files.reduce((n,f)=>n+f.changes,0)}}),immutable,noStore:access.private}
    }
    const [base,head]=hashes
    await this.record(access.id,head)
    const baseCommit=await this.record(access.id,base)
    const row=await this.db.prepare('SELECT state,data FROM prepared_history_comparisons WHERE id=? AND version=? AND base=? AND head=?').bind(access.id,HISTORY_VERSION,base,head).first<{state:string;data:string|null}>()
    if(!row)throw new PreparationPending()
    if(row.state==='unrelated')throw new ApiError(409,'Commits have no common ancestor')
    if(!row.data)throw new PreparationPending()
    const facts=JSON.parse(row.data) as {mergeBase:string;ahead:number;behind:number;files:HistoryFile[]}
    const mergeBase=await this.record(access.id,facts.mergeBase)
    const limit=c.query.per_page??30,offset=paginationOffset(c)
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ApiError(422,'Invalid comparison page size')
    const rows=(await this.db.prepare(`WITH page AS (SELECT c.data,n.position FROM prepared_history_comparison_nodes n JOIN prepared_history_commits c
      ON c.id=n.id AND c.version=n.version AND c.sha=n.sha AND c.state='ready'
      WHERE n.id=? AND n.version=? AND n.base=? AND n.head=? ORDER BY n.position LIMIT ? OFFSET ?)
      SELECT CASE WHEN sum(length(CAST(data AS BLOB))) OVER (ORDER BY position)<=? THEN data ELSE NULL END AS data FROM page ORDER BY position`)
      .bind(access.id,HISTORY_VERSION,base,head,limit,offset,HISTORY_PAGE_BYTES).all<{data:string|null}>()).results
    if(rows.some(r=>r.data===null)||rows.length!==Math.max(0,Math.min(limit,facts.ahead-offset)))throw new PreparationPending()
    const page=paginate(rows.map(r=>commitShape(scoped,JSON.parse(r.data!))),c,facts.ahead,true)
    return {data:output('compare',{url:apiURL(scoped,`${repoPath(scoped)}/compare/${base}...${head}`),html_url:`${origin(scoped)}/${access.owner}/${access.repo}/compare/${base}...${head}`,
      status:!facts.ahead&&!facts.behind?'identical':!facts.behind?'ahead':!facts.ahead?'behind':'diverged',ahead_by:facts.ahead,behind_by:facts.behind,total_commits:facts.ahead,
      base_commit:commitShape(scoped,baseCommit),merge_base_commit:commitShape(scoped,mergeBase),commits:page.data,files:fileShape(scoped,facts.files,head)}),headers:page.headers,immutable,noStore:access.private}
  }
}
