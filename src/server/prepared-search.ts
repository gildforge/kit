import type {D1Database} from '@cloudflare/workers-types'
import {ApiError} from '../engine/api/errors.js'
import {hasScope,type Principal} from '../engine/api/scopes.js'
import {PreparationPending,PreparedReadModels} from './prepared-read-models.js'
import {routes,type Output} from '../engine/api/contract.js'
import {repoShape} from './api/shapes.js'
import type {Context} from './api/dispatch.js'
import {atoms,matches,parseQuery,snippets,type Query,type Document} from '../engine/search-query.js'
import {searchSnapshotKey,type SearchSnapshot} from '../engine/prepared-search-key.js'
import type {PreparedRefs} from './prepared-repository-producer.js'

export const SEARCH_REPOSITORY_LIMIT=1024
export const SEARCH_CANDIDATE_LIMIT=2048
export const SEARCH_TEXT_BUDGET=2*1024*1024
const searchOutput=routes.find(r=>r.id==='searchCode')!.output
interface Repository {
  owner:string;kind:'org'|'user';name:string;id:string;description:string|null;default_branch:string;
  created_at:string|null;updated_at:string|null;stars:number;private:number;
  moving:number;pending:number|null;access_meta:string|null;listing:string|null;
  epoch:number|null;refs_meta:string|null;refs_pending:number|null;refs:string|null
}
interface Selected extends SearchSnapshot {repository:Repository;kind:'branch'|'tag'}
interface Candidate {snapshot:string;path:string;blob:string;language:string;content:string|null;symbols:string|null}
interface Narrow {sql:string;args:string[]}
/** Only positive predicates narrow candidates. NOT and unsupported qualifiers
 * remain a superset; final evaluation always uses the original query AST. */
function combine(q:Query,term:(q:Extract<Query,{op:'term'}>)=>Narrow):Narrow {
  if(q.op==='term')return term(q)
  if(q.op==='not')return {sql:'1',args:[]}
  const a=combine(q.left,term),b=combine(q.right,term)
  return {sql:`(${a.sql} ${q.op==='and'?'AND':'OR'} ${b.sql})`,args:[...a.args,...b.args]}
}
function scopeFilter(q:Query,ownerOnly=false):Narrow {
  return combine(q,a=>{
    if(a.field==='repo')return {sql:ownerOnly?'n.name=? COLLATE NOCASE':"c.owner||'/'||c.name=? COLLATE NOCASE",args:[ownerOnly?a.value.split('/')[0]:a.value]}
    if(a.field==='org'||a.field==='user')return {sql:'(n.kind=? AND n.name=? COLLATE NOCASE)',args:[a.field,a.value]}
    return {sql:'1',args:[]}
  })
}
/** Trigram exact substring narrowing over producer-lowercased text preserves
 * Unicode JS lowercasing, punctuation, phrases, boolean OR and path matches. */
export function searchCandidateFilter(q:Query):Narrow {
  return combine(q,a=>{
    if(a.form==='regex'||!['','content','path'].includes(a.field)||a.field==='path'&&a.form==='word'&&/[*?]/.test(a.value))return {sql:'1',args:[]}
    const value=a.value.toLowerCase()
    if([...value].length<3)return {sql:'1',args:[]}
    const phrase='"'+value.replaceAll('"','""')+'"'
    const prefix=a.field==='content'?'content : ':a.field==='path'?'path : ':''
    return {sql:'d.rowid IN (SELECT rowid FROM prepared_search_fts WHERE prepared_search_fts MATCH ?)',args:[prefix+phrase]}
  })
}

/** D1-only indexed reader. Publication ports live in prepared-search-producer;
 * no index/Git/network/build/scorer or producer callback can be reached here. */
export class PreparedSearch {
  private readonly db:D1Database
  constructor(db:D1Database){this.db=db}
  async read(p:Principal,request:Request,input:{q:string;limit?:number;offset?:number}):Promise<{data:Output<'searchCode'>;noStore:boolean}>{
    if(!hasScope(p,'repo:read'))throw new ApiError(403,'Requires repo:read scope')
    if(p.name.includes('/')){
      const agent=await this.db.prepare('SELECT revoked_at,suspended_at FROM agents WHERE name=?').bind(p.name).first<{revoked_at:string|null;suspended_at:string|null}>()
      if(!agent||agent.revoked_at||agent.suspended_at)throw new ApiError(404,'Not Found')
    }
    const limit=input.limit??30,offset=input.offset??0
    if(!input.q||input.q.length>2000||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>1000000)
      throw new ApiError(400,'Invalid search pagination or query')
    const {query}=parseQuery(input.q),name=p.name.toLowerCase(),allow=p.repos===null?null:JSON.stringify(p.repos)
    const ownerScope=scopeFilter(query,true)
    // Public owner identities form the search universe. An absent complete
    // catalogue must not certify a globally empty result, even before any
    // repositories have been discovered. Restricted tokens only consider their
    // named owners. This reveals no repository name or private readiness.
    const missing=(await this.db.prepare(`SELECT n.name,n.kind FROM owner_names n
      LEFT JOIN settings_entities e ON e.key=n.name COLLATE NOCASE
      LEFT JOIN prepared_catalogues g ON g.owner=n.name COLLATE NOCASE
      WHERE n.kind IN ('user','org') AND e.deleted_at IS NULL AND coalesce(e.moving,0)=0
      AND coalesce(e.id,'') NOT LIKE 'reserve:%' AND g.owner IS NULL
      AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(?) a WHERE lower(substr(a.value,1,instr(a.value,'/')-1))=lower(n.name)))
      AND ${ownerScope.sql} LIMIT ?`).bind(allow,allow,...ownerScope.args,SEARCH_REPOSITORY_LIMIT+1).all<{name:string;kind:'user'|'org'}>()).results
    if(missing.length>SEARCH_REPOSITORY_LIMIT)throw new PreparationPending()
    const explicit=p.repos??atoms(query).filter(a=>a.field==='repo').map(a=>a.value)
    for(const owner of missing){
      if(!explicit.length&&p.repos===null)throw new PreparationPending()
      // Named/allowlisted scopes reuse the authoritative prepared ACL reader
      // before revealing the absent inventory. Private outsiders and unknown
      // repositories remain absent search results, rather than private Pending.
      for(const address of explicit){
        const [target,name]=address.split('/')
        if(target.toLowerCase()!==owner.name.toLowerCase()||!name)continue
        const scope=scopeFilter(query)
        const relevant=await this.db.prepare(`SELECT 1 FROM (SELECT ? AS owner,? AS name) c,
          (SELECT ? AS name,? AS kind) n WHERE ${scope.sql}`).bind(owner.name,name,owner.name,owner.kind,...scope.args).first()
        if(!relevant)continue
        try{await new PreparedReadModels(this.db).repositoryAccess(p,owner.name,name)}
        catch(error){if(error instanceof ApiError&&[403,404].includes(error.status))continue;throw error}
        throw new PreparationPending()
      }
    }
    const scope=scopeFilter(query)
    const repositories=(await this.db.prepare(`SELECT c.owner,n.kind,c.name,coalesce(e.id,c.id) AS id,
      coalesce(e.description,c.description) AS description,coalesce(e.default_branch,c.default_branch) AS default_branch,
      c.created_at,c.updated_at,(SELECT count(*) FROM stars WHERE repo=coalesce(e.id,c.id)) AS stars,
      (coalesce(json_extract(a.acl,'$.visibility'),'public')='private' OR coalesce(json_extract(a.acl,'$.private'),0)=1) AS private,
      coalesce(e.moving,0) AS moving,a.pending,a.meta AS access_meta,l.data AS listing,
      r.epoch,r.pending AS refs_pending,r.meta AS refs_meta,r.data AS refs
      FROM prepared_repositories c JOIN prepared_catalogues g ON g.owner=c.owner AND g.checked_at=c.checked_at
      JOIN owner_names n ON n.name=c.owner COLLATE NOCASE AND n.kind IN ('user','org')
      LEFT JOIN settings_entities e ON e.key=c.owner||'/'||c.name COLLATE NOCASE
      LEFT JOIN settings_entities oe ON oe.key=c.owner COLLATE NOCASE
      LEFT JOIN org_members m ON m.org=c.owner COLLATE NOCASE AND m.member=? COLLATE NOCASE AND instr(?,'/')=0
      LEFT JOIN repo_access a ON a.id=coalesce(e.id,c.id)
      LEFT JOIN repo_listing l ON l.id=coalesce(e.id,c.id)
      LEFT JOIN prepared_repository_refs r ON r.id=coalesce(e.id,c.id)
      WHERE c.active=1 AND e.deleted_at IS NULL AND oe.deleted_at IS NULL AND coalesce(oe.moving,0)=0
      AND coalesce(e.id,c.id) NOT LIKE 'reserve:%'
      AND (? IS NULL OR lower(c.owner||'/'||c.name) IN (SELECT lower(value) FROM json_each(?)))
      AND ((instr(?,'/')=0 AND ?!='' AND (?=c.owner COLLATE NOCASE OR m.role IS NOT NULL))
        OR (a.pending=0 AND ((coalesce(json_extract(a.acl,'$.visibility'),'public')!='private' AND coalesce(json_extract(a.acl,'$.private'),0)=0)
          OR (?!='' AND (EXISTS(SELECT 1 FROM json_each(a.acl,'$.read') WHERE lower(value)=?)
            OR EXISTS(SELECT 1 FROM json_each(a.acl,'$.write') WHERE lower(value)=?)
            OR (instr(?,'/')=0 AND EXISTS(SELECT 1 FROM json_each(a.acl,'$.owners') WHERE lower(value)=?))))
          OR (instr(?,'/')>0 AND coalesce(json_array_length(json_extract(a.acl,?)),0)>0))))
      AND ${scope.sql} ORDER BY lower(c.owner),lower(c.name),c.owner,c.name LIMIT ?`)
      .bind(name,name,allow,allow,name,name,name,name,'@'+name,'@'+name,name,'@'+name,name,'$.agents.'+JSON.stringify('@'+name),...scope.args,SEARCH_REPOSITORY_LIMIT+1).all<Repository>()).results
    if(repositories.length>SEARCH_REPOSITORY_LIMIT)throw new PreparationPending()
    const selected:Selected[]=[]
    let noStore=false
    const requested=[...new Set(atoms(query).filter(a=>a.field==='ref'||a.field==='branch').map(a=>a.value))]
    for(const repository of repositories){
      if(repository.moving||repository.pending!==0||!repository.listing||repository.epoch===null||repository.refs_pending!==0||!repository.refs||repository.refs_meta!==repository.access_meta)
        throw new PreparationPending()
      const listing=JSON.parse(repository.listing) as {meta:string|null}
      if(listing.meta!==repository.access_meta)throw new PreparationPending()
      const refs=JSON.parse(repository.refs) as PreparedRefs
      if(!refs.ready)throw new PreparationPending()
      noStore ||=!!repository.private
      for(const ref of requested.length?requested:[refs.defaultBranch]){
        const advertised=refs.refs.find(r=>r.name===ref)??refs.refs.find(r=>r.name.toLowerCase()===ref.toLowerCase())
        if(!advertised)continue
        selected.push({id:repository.id,epoch:repository.epoch,meta:repository.access_meta,ref:advertised.name,tip:advertised.hash,kind:advertised.kind,repository})
      }
    }
    const bySnapshot=new Map(selected.map(s=>[searchSnapshotKey(s),s]))
    const keys=JSON.stringify([...bySnapshot.keys()])
    const receipts=(await this.db.prepare(`SELECT snapshot FROM prepared_search_receipts WHERE snapshot IN (SELECT value FROM json_each(?))`).bind(keys).all<{snapshot:string}>()).results
    if(receipts.length!==bySnapshot.size)throw new PreparationPending()
    const narrow=searchCandidateFilter(query)
    // Bound both rows and cumulative original-text bytes in SQLite BEFORE
    // materializing Worker candidates. Regex/short/NOT-only searches are honest
    // lower bounds; they never transfer an unbounded repository to the Worker.
    const candidates=(await this.db.prepare(`WITH bounded AS (
      SELECT d.* FROM prepared_search_documents d
      WHERE d.snapshot IN (SELECT value FROM json_each(?)) AND ${narrow.sql}
      ORDER BY d.snapshot,d.path LIMIT ?
    ), candidates AS (
      SELECT *,sum(length(CAST(content AS BLOB))+length(CAST(symbols AS BLOB))) OVER (ORDER BY snapshot,path) AS bytes FROM bounded
    ) SELECT snapshot,path,blob,language,CASE WHEN bytes<=? THEN symbols ELSE NULL END AS symbols,CASE WHEN bytes<=? THEN content ELSE NULL END AS content
      FROM candidates ORDER BY snapshot,path`)
      .bind(keys,...narrow.args,SEARCH_CANDIDATE_LIMIT+1,SEARCH_TEXT_BUDGET,SEARCH_TEXT_BUDGET).all<Candidate>()).results
    const items:Output<'searchCode'>['items']=[]
    let total=0,incomplete=false
    const context={request} as Context
    for(const [position,row] of candidates.entries()){
      if(position>=SEARCH_CANDIDATE_LIMIT||row.content===null){incomplete=true;break}
      const snapshot=bySnapshot.get(row.snapshot)!,r=snapshot.repository
      const document:Document={repo:r.owner+'/'+r.name,ownerKind:r.kind,ref:snapshot.ref,refKind:snapshot.kind,path:row.path,language:row.language,content:row.content,symbols:JSON.parse(row.symbols!)}
      if(!matches(query,document))continue
      total++
      if(total<=offset||items.length>=limit)continue
      if(!r.created_at||!r.updated_at)throw new PreparationPending()
      const repository=repoShape(context,r.owner,r.name,r.default_branch,{private:!!r.private,description:r.description,stargazers_count:r.stars,
        created_at:r.created_at,updated_at:r.updated_at})
      const path='/repos/'+r.owner+'/'+r.name+'/contents/'+row.path
      items.push({name:row.path.split('/').pop()!,path:row.path,sha:row.blob,repository,
        url:new URL('/api/v1'+path+'?ref='+snapshot.tip,request.url).href,
        html_url:new URL('/'+r.owner+'/'+r.name+'/blob/'+snapshot.tip+'/'+row.path,request.url).href,
        text_matches:snippets(query,document).map(l=>({fragment:l.text,matches:l.ranges.map(indices=>({indices,text:l.text.slice(...indices)}))}))})
    }
    const data=searchOutput.parse({total_count:total,incomplete_results:incomplete,items}) as Output<'searchCode'>
    return {data,noStore:noStore||incomplete}
  }
}
