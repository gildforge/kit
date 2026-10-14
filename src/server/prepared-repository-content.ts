import type {D1Database} from '@cloudflare/workers-types'
import type {Principal} from '../engine/api/scopes.js'
import type {Context} from './api/dispatch.js'
import {routes,type Output} from '../engine/api/contract.js'
import {apiURL,repoPath} from './api/shapes.js'
import {ApiError} from '../engine/api/errors.js'
import {PreparationPending,type PreparedRepositoryAccess} from './prepared-read-models.js'
import type {PreparedRefs} from './prepared-repository-producer.js'
import {SHA,refHash} from '../engine/api/ref-resolution.js'

export const CONTENT_VERSION='repository-content:v1'
export const PREPARED_CONTENT_OPERATIONS=['contentsRoot','contents','tree','blob'] as const
type ContentOperation=typeof PREPARED_CONTENT_OPERATIONS[number]
export interface ContentPolicy {
  repositoryAccess(p:Principal,owner:string,repo:string):Promise<PreparedRepositoryAccess>
  repositoryRefs(p:Principal,owner:string,repo:string,access:PreparedRepositoryAccess):Promise<PreparedRefs>
}
export interface ContentEntry {
  path:string;mode:string;type:'tree'|'blob'|'commit';sha:string;size:number
}
interface EntryRow {path:string;name:string;kind:ContentEntry['type'];mode:string;object_sha:string;size:number}
function validOutput<I extends ContentOperation>(id:I,data:unknown):Output<I>{
  const parsed=routes.find(route=>route.id===id)!.output.safeParse(data)
  if(!parsed.success)throw new PreparationPending()
  return parsed.data as Output<I>
}

/** Parent wiring: construct with actual PreparedReadModels as policy port; call
 * response only for PREPARED_CONTENT_OPERATIONS, before any legacy index lookup.
 * It deliberately rechecks current access for each request, including immutable
 * object requests; cached object existence never grants repository visibility. */
export class PreparedRepositoryContent {
  private readonly db:D1Database
  private readonly policy:ContentPolicy
  constructor(db:D1Database,policy:ContentPolicy){this.db=db;this.policy=policy}
  private async resolve(p:Principal,owner:string,repo:string,access:PreparedRepositoryAccess,input?:string){
    if(input&&SHA.test(input))return input
    const refs=await this.policy.repositoryRefs(p,owner,repo,access)
    const sha=refHash(refs.refs,refs.defaultBranch,input)
    if(!sha)throw new ApiError(404,'Not Found')
    return sha
  }
  private async blob(id:string,sha:string){
    const row=await this.db.prepare('SELECT size,content FROM prepared_content_blobs WHERE id=? AND version=? AND sha=?')
      .bind(id,CONTENT_VERSION,sha).first<{size:number;content:string}>()
    if(!row)throw new PreparationPending()
    return row
  }
  async response(c:Context){
    const operation=c.route.id
    if(!PREPARED_CONTENT_OPERATIONS.includes(operation as ContentOperation))throw new Error('Unsupported prepared content operation')
    const {owner,repo}=c.params,p=c.principal
    const access=await this.policy.repositoryAccess(p,owner,repo)
    const path=repoPath(c),url=(suffix:string)=>apiURL(c,path+suffix)
    if(operation==='blob'){
      if(!SHA.test(c.params.sha))throw new ApiError(404,'Not Found')
      return {data:validOutput('blob',{sha:c.params.sha,url:url('/git/blobs/'+c.params.sha),encoding:'base64',...await this.blob(access.id,c.params.sha)}),immutable:true,noStore:access.private}
    }
    if(operation==='tree'){
      const input=c.params.sha,recursive=c.query.recursive!==undefined?1:0
      // The legacy tree route accepts either an object SHA or commit/ref. Try
      // an exact prepared tree first; never guess a hash prefix or fetch Git.
      let tree=SHA.test(input)?input:await this.resolve(p,owner,repo,access,input)
      let row=await this.db.prepare('SELECT data FROM prepared_content_trees WHERE id=? AND version=? AND sha=? AND recursive=?')
        .bind(access.id,CONTENT_VERSION,tree,recursive).first<{data:string}>()
      if(!row){
        const commit=await this.db.prepare('SELECT tree FROM prepared_content_snapshots WHERE id=? AND version=? AND sha=?')
          .bind(access.id,CONTENT_VERSION,tree).first<{tree:string}>()
        if(!commit)throw new PreparationPending()
        tree=commit.tree
        row=await this.db.prepare('SELECT data FROM prepared_content_trees WHERE id=? AND version=? AND sha=? AND recursive=?')
          .bind(access.id,CONTENT_VERSION,tree,recursive).first<{data:string}>()
      }
      if(!row)throw new PreparationPending()
      const entries=JSON.parse(row.data) as ContentEntry[]
      return {data:validOutput('tree',{sha:tree,url:url('/git/trees/'+tree),tree:entries.map(({path,mode,type,sha})=>({path,mode,type,sha,url:url('/git/'+(type==='tree'?'trees':'blobs')+'/'+sha)})),truncated:false}),immutable:SHA.test(input),noStore:access.private}
    }
    const hash=await this.resolve(p,owner,repo,access,c.query.ref as string|undefined)
    const snapshot=await this.db.prepare('SELECT tree FROM prepared_content_snapshots WHERE id=? AND version=? AND sha=?')
      .bind(access.id,CONTENT_VERSION,hash).first<{tree:string}>()
    if(!snapshot)throw new PreparationPending()
    // Matches existing contents normalization: empty slash segments disappear.
    const filePath=(c.params.path??'').split('/').filter(Boolean).join('/')
    const entry=filePath?await this.db.prepare('SELECT path,name,kind,mode,object_sha,size FROM prepared_content_entries WHERE id=? AND version=? AND sha=? AND path=?')
      .bind(access.id,CONTENT_VERSION,hash,filePath).first<EntryRow>():null
    if(filePath&&!entry)throw new ApiError(404,'Not Found')
    const shape=async(e:EntryRow,full=false)=>{
      const bytes=full&&e.kind==='blob'?await this.blob(access.id,e.object_sha):null
      if(bytes&&bytes.size!==e.size)throw new PreparationPending()
      return {type:e.kind==='tree'?'dir':e.kind==='commit'?'submodule':'file',name:e.name,path:e.path,sha:e.object_sha,size:e.size,
        url:url('/contents/'+e.path+'?ref='+hash),html_url:new URL(c.request.url).origin+'/'+owner+'/'+repo+'/blob/'+hash+'/'+e.path,
        git_url:url('/git/'+(e.kind==='tree'?'trees':'blobs')+'/'+e.object_sha),
        download_url:e.kind==='blob'?url('/contents/'+e.path+'?ref='+hash):null,
        ...(bytes?{encoding:'base64',content:bytes.content}:{})}
    }
    const data=entry&&entry.kind!=='tree'?await shape(entry,true):await Promise.all(
      (await this.db.prepare('SELECT path,name,kind,mode,object_sha,size FROM prepared_content_entries WHERE id=? AND version=? AND sha=? AND parent=? ORDER BY ordinal')
        .bind(access.id,CONTENT_VERSION,hash,filePath).all<EntryRow>()).results.map(e=>shape(e)))
    return {data:validOutput(operation as 'contents'|'contentsRoot',data),immutable:SHA.test(String(c.query.ref??'')),noStore:access.private}
  }
}
