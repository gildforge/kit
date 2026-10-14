import type {D1Database} from '@cloudflare/workers-types'
import type {Context,Result} from './api/dispatch.js'
import {paginate,paginationOffset} from './api/dispatch.js'
import {ApiError} from '../engine/api/errors.js'
import {apiURL,repoPath,repoShape,issueShape,pullShape,commentShape,reviewShape} from './api/shapes.js'
import {PreparationPending,type PreparedReadModels,type PreparedRepositoryAccess} from './prepared-read-models.js'
import type {Issue,Comment} from './issues.js'
import type {Pull,Review} from './pulls.js'
import type {InlineComment} from './api/metadata.js'
import type {ConversationRepository} from './prepared-conversations-producer.js'

export const PREPARED_CONVERSATION_OPERATIONS=['issues','pulls','issue','pull','issueComments','pullComments','pullReviews'] as const
interface Receipt {generation:string;repository:string}
interface Thread {number:number;kind:'issue'|'pr';updated_at:string;comments:number;data:string;head:string|null;base:string|null}
const operations=new Set<string>(PREPARED_CONVERSATION_OPERATIONS)

/** Shared HTTP/SSR read service. Only primary D1 and the existing strict policy
 * reader are accepted; mutations, live events, channels and CAS stay with their
 * existing providers. Every call rechecks current policy before readiness. */
export class PreparedConversations {
  private readonly db:D1Database
  private readonly policy:PreparedReadModels
  constructor(db:D1Database,policy:PreparedReadModels){this.db=db;this.policy=policy}
  private async receipt(access:PreparedRepositoryAccess):Promise<Receipt>{
    const row=await this.db.prepare(`SELECT c.generation,r.repository FROM prepared_conversation_receipts c
      JOIN prepared_conversation_runs r ON r.id=c.id AND r.generation=c.generation AND r.complete=1
      JOIN prepared_repository_refs f ON f.id=c.id AND f.epoch=c.epoch AND f.pending=0 AND f.meta IS c.meta AND f.data IS r.refs
      WHERE c.id=? AND c.meta IS ?`).bind(access.id,access.meta).first<Receipt>()
    if(!row)throw new PreparationPending()
    return row
  }
  private issue(c:Context,row:Thread){
    const item=JSON.parse(row.data) as Issue|Pull
    if(row.kind==='issue')return issueShape(c,item as Issue,row.comments,row.updated_at)
    return {...issueShape(c,{...item,state:item.state==='merged'?'closed':item.state,labels:[],claim:null} as Issue,row.comments,row.updated_at),
      pull_request:{url:apiURL(c,`${repoPath(c)}/pulls/${row.number}`),html_url:`${new URL(c.request.url).origin}/${c.params.owner}/${c.params.repo}/pulls/${row.number}`}}
  }
  private pull(c:Context,row:Thread,receipt:Receipt,access:PreparedRepositoryAccess){
    const item=JSON.parse(row.data) as Pull,info=JSON.parse(receipt.repository) as ConversationRepository
    if(!row.head||!row.base||!info.createdAt||!info.updatedAt)throw new PreparationPending()
    return pullShape(c,item,repoShape(c,access.owner,access.repo,info.defaultBranch,{private:access.private,
      description:info.description,stargazers_count:info.stars,created_at:info.createdAt??undefined,updated_at:info.updatedAt??undefined}),row.head,row.base,row.comments)
  }
  async read(c:Context):Promise<Result>{
    const op=c.route.id
    if(c.request.method!=='GET'||!operations.has(op))throw new ApiError(404,'Not Found')
    const access=await this.policy.repositoryAccess(c.principal,c.params.owner,c.params.repo)
    const receipt=await this.receipt(access)
    // Canonical alias resolution controls addresses as well as ACL lookup.
    const context={...c,params:{...c.params,owner:access.owner,repo:access.repo}}
    let result:Result
    if(op==='issues'||op==='pulls'){
      const q=c.query,offset=paginationOffset(context),per=q.per_page??30
      // Filtering and ordering use normalized columns and JSON label membership.
      // Pull labels intentionally retain the existing issues-list semantics.
      const where=`id=? AND generation=? AND (?='issues' OR kind='pr')
        AND (?='all' OR (CASE state WHEN 'merged' THEN 'closed' ELSE state END)=?)
        AND (kind='pr' OR NOT EXISTS (SELECT 1 FROM json_each(?) wanted WHERE NOT EXISTS
          (SELECT 1 FROM json_each(labels) actual WHERE actual.value=wanted.value)))`
      const args=[access.id,receipt.generation,op,q.state??'open',q.state??'open',JSON.stringify(q.labels?q.labels.split(','):[])]
      const sort=q.sort==='updated'?'updated_at':q.sort==='comments'?'comments':'number',direction=q.direction==='asc'?'ASC':'DESC'
      const total=(await this.db.prepare(`SELECT count(*) AS n FROM prepared_conversation_threads WHERE ${where}`).bind(...args).first<{n:number}>())!.n
      const rows=(await this.db.prepare(`SELECT number,kind,updated_at,comments,data,head,base FROM prepared_conversation_threads WHERE ${where}
        ORDER BY ${sort} ${direction},number ${direction},kind LIMIT ? OFFSET ?`).bind(...args,per,offset).all<Thread>()).results
      result=paginate(rows.map(row=>op==='issues'?this.issue(context,row):this.pull(context,row,receipt,access)),context,total,true)
    }else{
      const number=Number(c.params.number)
      if(!Number.isSafeInteger(number)||number<1)throw new ApiError(404,'Not Found')
      const issues=op==='issue'||op==='issueComments'
      const row=await this.db.prepare(`SELECT number,kind,updated_at,comments,data,head,base FROM prepared_conversation_threads
        WHERE id=? AND generation=? AND number=? AND (?=1 OR kind='pr') ORDER BY CASE kind WHEN 'issue' THEN 0 ELSE 1 END LIMIT 1`)
        .bind(access.id,receipt.generation,number,issues?1:0).first<Thread>()
      if(!row)throw new ApiError(404,'Not Found')
      if(op==='issue')result={data:this.issue(context,row)}
      else if(op==='pull')result={data:this.pull(context,row,receipt,access)}
      else{
        const reviews=op==='pullReviews',table=reviews?'prepared_conversation_reviews':'prepared_conversation_comments'
        const where=reviews?'id=? AND generation=? AND number=?':'id=? AND generation=? AND number=? AND kind=? AND (?=0 OR inline=1)'
        const args=reviews?[access.id,receipt.generation,number]:[access.id,receipt.generation,number,row.kind,op==='pullComments'?1:0]
        const total=(await this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).bind(...args).first<{n:number}>())!.n
        const rows=(await this.db.prepare(`SELECT data FROM ${table} WHERE ${where} ORDER BY ordinal,source_id LIMIT ? OFFSET ?`)
          .bind(...args,c.query.per_page??30,paginationOffset(context)).all<{data:string}>()).results
        const data=rows.map(r=>{
          if(reviews)return reviewShape(context,number,JSON.parse(r.data) as Review)
          const comment=JSON.parse(r.data) as Comment|InlineComment
          if(op==='pullComments'){
            const inline=comment as InlineComment
            return {...commentShape(context,number,comment),path:inline.path,line:inline.line,side:inline.side,commit_id:inline.commit_id}
          }
          return commentShape(context,number,comment)
        })
        result=paginate(data,context,total,true)
      }
    }
    const validated=c.route.output.safeParse(result.data)
    if(!validated.success)throw new PreparationPending()
    return {...result,data:validated.data,noStore:access.private||!!c.principal.name}
  }
}
