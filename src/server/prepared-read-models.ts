import type {D1Database} from '@cloudflare/workers-types'
import {ApiError} from '../engine/api/errors.js'
import {PREPARATION_PENDING,type RepositoryCard,type PublicDisplayProfile,type ViewerContext} from '../engine/api/read-contract.js'
import {hasScope,permitsRepo,type Principal} from '../engine/api/scopes.js'
import {emptyProfile,type Profile} from './settings-store.js'
import {resolvePicture} from '../engine/profile.js'
import type {ListingSnapshot} from './repo-list-snapshot.js'
import type {PreparedRefs} from './prepared-repository-producer.js'
import {scoreCacheKey} from './cqx-score-cache.js'
import {agentAttached,contributorAcl} from './repo-read.js'
import type {Report} from './cqx-wasm.js'
import type {Change} from './changes.js'
import {CHANGE_VERSION} from '../engine/api/change-version.js'
import {SHA,refHash} from '../engine/api/ref-resolution.js'

export const PREPARED_REPO_READ_OPERATIONS = ['branches','refs','ref','health','healthAt','commitChanges','pullChanges'] as const

export class PreparationPending extends ApiError {
  readonly code=PREPARATION_PENDING
  constructor(){super(503,'Pending · repository data is being prepared')}
}
interface OwnerRow {
  name:string;kind:'user'|'org';email:string|null;profile:string|null;role:string|null;
  deleted_at:number|null;moving:number|null;id:string|null
}
interface RepoRow {
  owner:string;name:string;id:string;description:string|null;default_branch:string;
  created_at:string|null;updated_at:string|null;data:string|null;
  access_meta:string|null;access_acl:string|null;access_pending:number|null;
  archived:number;owner_archived:number;role:string|null;moving:number;stars:number;prepared:number
}
const ownerPattern=/^[a-z0-9][a-z0-9-]{0,38}$/i
const repoPattern=/^[a-z0-9][a-z0-9._-]{0,99}$/i
export interface PreparedRepositoryAccess {id:string;owner:string;repo:string;meta:string|null;private:boolean;/** May see Actions, Agents and Score. */contributor?:boolean}

/** The strict read port only accepts D1. No index, Git, network, scorer,
 * producer, build or loopback HTTP dependency exists on this object. */
export class PreparedReadModels {
  private readonly db:D1Database
  constructor(db:D1Database){this.db=db}
  private async owner(input:string,principal:Principal):Promise<OwnerRow>{
    if(!ownerPattern.test(input))throw new ApiError(404,'Not Found')
    // Alias resolution stays in SQLite and is bounded; no Artifacts catalogue.
    const canonical=await this.db.prepare(`WITH RECURSIVE names(name,depth) AS (
      SELECT ?,0 UNION ALL SELECT a.target,n.depth+1 FROM names n
      JOIN settings_aliases a ON a.name=n.name COLLATE NOCASE WHERE n.depth<100
    ) SELECT name FROM names ORDER BY depth DESC LIMIT 1`).bind(input.toLowerCase()).first<{name:string}>()
    const name=canonical?.name??input.toLowerCase()
    const row=await this.db.prepare(`SELECT n.name,n.kind,c.email,p.data AS profile,m.role,
      e.id,e.deleted_at,e.moving FROM owner_names n
      LEFT JOIN claims c ON c.name=n.name COLLATE NOCASE
      LEFT JOIN profiles p ON p.name=n.name COLLATE NOCASE
      LEFT JOIN settings_entities e ON e.key=n.name COLLATE NOCASE
      LEFT JOIN org_members m ON m.org=n.name COLLATE NOCASE AND m.member=? COLLATE NOCASE
        AND instr(?, '/')=0
      WHERE n.name=? COLLATE NOCASE AND n.kind IN ('user','org')`).bind(principal.name,principal.name,name).first<OwnerRow>()
    if(!row||row.deleted_at!==null&&row.deleted_at!==undefined||row.id?.startsWith('reserve:'))throw new ApiError(404,'Not Found')
    return row
  }
  private async active(principal:Principal){
    if(!principal.name.includes('/'))return
    const agent=await this.db.prepare('SELECT revoked_at,suspended_at FROM agents WHERE name=?').bind(principal.name).first<{revoked_at:string|null;suspended_at:string|null}>()
    if(!agent||agent.revoked_at||agent.suspended_at)throw new ApiError(404,'Not Found')
  }
  private structural(owner:OwnerRow,p:Principal){return !!p.name&&!p.name.includes('/')&&(p.name.toLowerCase()===owner.name.toLowerCase()||!!owner.role)}
  private async rows(owner:OwnerRow,p:Principal,page:number,perPage:number,repo:string|null=null){
    const name=p.name.toLowerCase()
    // Authorize EACH row in the primary query before pagination or readiness.
    // A pending ACL grants only structural humans, never stale collaborators.
    return (await this.db.prepare(`WITH candidates AS (
      SELECT c.*,1 AS prepared FROM prepared_repositories c
      JOIN prepared_catalogues generation ON generation.owner=c.owner AND generation.checked_at=c.checked_at
      WHERE c.owner=? COLLATE NOCASE AND (? IS NULL OR c.name=? COLLATE NOCASE) AND c.active=1
      UNION ALL
      SELECT ?,?,a.id,1,NULL,'main',NULL,NULL,0,0 FROM repo_access a
      LEFT JOIN settings_entities identity ON identity.key=? COLLATE NOCASE
      WHERE ? IS NOT NULL AND a.id=coalesce(identity.id,?)
      AND NOT EXISTS (SELECT 1 FROM prepared_repositories pc JOIN prepared_catalogues g
        ON g.owner=pc.owner AND g.checked_at=pc.checked_at
        WHERE pc.owner=? COLLATE NOCASE AND pc.name=? COLLATE NOCASE AND pc.active=1)
    ) SELECT c.owner,c.name,coalesce(e.id,c.id) AS id,c.prepared,
      coalesce(e.description,c.description) AS description,coalesce(e.default_branch,c.default_branch) AS default_branch,
      c.created_at,c.updated_at,l.data,a.meta AS access_meta,a.acl AS access_acl,a.pending AS access_pending,
      coalesce(e.archived,0) AS archived,coalesce(oe.archived,0) AS owner_archived,membership.role,coalesce(e.moving,0) AS moving,
      (SELECT count(*) FROM stars s WHERE s.repo=coalesce(e.id,c.id)) AS stars
      FROM candidates c
      LEFT JOIN settings_entities oe ON oe.key=c.owner COLLATE NOCASE
      LEFT JOIN org_members membership ON membership.org=c.owner COLLATE NOCASE AND membership.member=? COLLATE NOCASE AND instr(?,'/')=0
      LEFT JOIN settings_entities e ON e.key=c.owner||'/'||c.name COLLATE NOCASE
      LEFT JOIN repo_listing l ON l.id=coalesce(e.id,c.id)
      LEFT JOIN repo_access a ON a.id=coalesce(e.id,c.id)
      WHERE c.owner=? COLLATE NOCASE AND c.active=1 AND (? IS NULL OR c.name=? COLLATE NOCASE)
      AND e.deleted_at IS NULL AND oe.deleted_at IS NULL AND coalesce(oe.moving,0)=0
      AND coalesce(e.id,c.id) NOT LIKE 'reserve:%'
      AND (? IS NULL OR lower(c.owner||'/'||c.name) IN (SELECT lower(value) FROM json_each(?)))
      AND ((instr(?,'/')=0 AND ?!='' AND (?=c.owner COLLATE NOCASE OR membership.role IS NOT NULL)) OR (a.pending=0 AND (
        (coalesce(json_extract(a.acl,'$.visibility'),'public')!='private' AND coalesce(json_extract(a.acl,'$.private'),0)=0)
        OR (?!='' AND (EXISTS(SELECT 1 FROM json_each(a.acl,'$.read') WHERE lower(value)=?)
          OR EXISTS(SELECT 1 FROM json_each(a.acl,'$.write') WHERE lower(value)=?)
          OR (instr(?,'/')=0 AND EXISTS(SELECT 1 FROM json_each(a.acl,'$.owners') WHERE lower(value)=?))))
        OR (instr(?,'/')>0 AND coalesce(json_array_length(json_extract(a.acl,?)),0)>0)
      ))) ORDER BY lower(c.name),c.name LIMIT ? OFFSET ?`)
      .bind(owner.name,repo,repo,owner.name,repo,owner.name+'/'+(repo??''),repo,owner.name+'/'+(repo??''),owner.name,repo,
        name,name,owner.name,repo,repo,p.repos===null?null:JSON.stringify(p.repos),p.repos===null?null:JSON.stringify(p.repos),
        name,name,name,name,'@'+name,'@'+name,name,'@'+name,name,'$.agents.'+JSON.stringify('@'+name),perPage+1,(page-1)*perPage).all<RepoRow>()).results
  }
  private card(row:RepoRow):RepositoryCard{
    if(!row.prepared||row.moving||!row.data||!row.access_acl||row.access_pending)throw new PreparationPending()
    const snapshot=JSON.parse(row.data) as ListingSnapshot
    if(snapshot.meta!==row.access_meta)throw new PreparationPending()
    const acl=JSON.parse(row.access_acl) as ListingSnapshot['acl']
    const factsTip=snapshot.factsTip??null
    const currentFacts=!!snapshot.tip&&factsTip===snapshot.tip&&!!snapshot.facts
    return {owner:row.owner,name:row.name,description:row.description,defaultBranch:row.default_branch,
      private:acl.private===true||acl.visibility==='private',archived:!!row.archived,tip:snapshot.tip,
      createdAt:row.created_at,updatedAt:row.updated_at,stars:row.stars,issues:snapshot.issues,pulls:snapshot.pulls,
      summaryPending:!!snapshot.tip&&!currentFacts,factsTip,facts:currentFacts?snapshot.facts:null}
  }
  async repositoryAccess(p:Principal,inputOwner:string,inputRepo:string){
    await this.active(p)
    if(!repoPattern.test(inputRepo))throw new ApiError(404,'Not Found')
    const owner=await this.owner(inputOwner,p)
    const row=(await this.rows(owner,p,1,1,inputRepo))[0]
    if(!row)throw new ApiError(404,'Not Found')
    if(!hasScope(p,'repo:read'))throw new ApiError(403,'Requires repo:read scope')
    const card=this.card(row)
    const acl=JSON.parse(row.access_acl!) as ListingSnapshot['acl'],name=p.anonymous?null:p.name||null
    const role=name&&!name.includes('/')&&name.toLowerCase()!==row.owner.toLowerCase()
      ?(await this.db.prepare('SELECT role FROM org_members WHERE lower(org)=lower(?) AND lower(member)=lower(?)').bind(row.owner,name).first<{role:string}>())?.role??null:null
    const contributor=!!name&&(name.includes('/')?agentAttached(acl,name):contributorAcl(row.owner,name,role,acl))
    return {id:row.id,owner:row.owner,repo:row.name,meta:row.access_meta,private:card.private,contributor}
  }
  async repositoryRefs(p:Principal,owner:string,repo:string,authorized?:PreparedRepositoryAccess):Promise<PreparedRefs>{
    const access=authorized??await this.repositoryAccess(p,owner,repo)
    const row=await this.db.prepare('SELECT pending,meta,data FROM prepared_repository_refs WHERE id=?').bind(access.id)
      .first<{pending:number;meta:string|null;data:string|null}>()
    if(!row||row.pending||row.meta!==access.meta||!row.data)throw new PreparationPending()
    return JSON.parse(row.data) as PreparedRefs
  }
  async repositoryHealth(p:Principal,owner:string,repo:string,input?:string,authorized?:PreparedRepositoryAccess):Promise<Report|null>{
    const access=authorized??await this.repositoryAccess(p,owner,repo)
    let sha:string
    if(input&&SHA.test(input))sha=input
    else{
      const refs=await this.repositoryRefs(p,owner,repo,access)
      const resolved=refHash(refs.refs,refs.defaultBranch,input)
      if(!resolved)throw new ApiError(404,'Not Found')
      sha=resolved
    }
    const key=scoreCacheKey(access.owner,access.repo,sha)
    const row=await this.db.prepare('SELECT data FROM prepared_repository_health WHERE cache_key=? AND id=? AND sha=?')
      .bind(key,access.id,sha).first<{data:string}>()
    if(!row)throw new PreparationPending()
    return JSON.parse(row.data) as Report|null
  }
  async repositoryDiff(p:Principal,owner:string,repo:string,kind:'commit'|'pull',input:string,authorized?:PreparedRepositoryAccess):Promise<Change>{
    const access=authorized??await this.repositoryAccess(p,owner,repo)
    let target=input,head:string|undefined,base:string|undefined
    if(kind==='commit'&&!SHA.test(input)){
      const refs=await this.repositoryRefs(p,owner,repo,access)
      const resolved=refHash(refs.refs,refs.defaultBranch,input)
      if(!resolved)throw new ApiError(404,'Not Found')
      target=resolved
    }
    if(kind==='pull'){
      const catalogue=await this.db.prepare('SELECT meta FROM prepared_pull_catalogues WHERE id=?').bind(access.id).first<{meta:string|null}>()
      if(!catalogue||catalogue.meta!==access.meta)throw new PreparationPending()
      const pull=await this.db.prepare('SELECT head_ref,base_ref FROM prepared_pull_heads WHERE id=? AND number=? AND meta IS ?')
        .bind(access.id,Number(input),access.meta).first<{head_ref:string;base_ref:string}>()
      if(!pull)throw new ApiError(404,'Not Found')
      const refs=await this.repositoryRefs(p,owner,repo,access)
      const resolve=(name:string)=>refHash(refs.refs,refs.defaultBranch,name)
      head=resolve(pull.head_ref);base=resolve(pull.base_ref)
      if(!head||!base)throw new ApiError(404,'Not Found')
    }
    const row=await this.db.prepare('SELECT head,base,meta,data FROM prepared_repository_diffs WHERE id=? AND version=? AND kind=? AND target=?')
      .bind(access.id,CHANGE_VERSION,kind,target).first<{head:string;base:string|null;meta:string|null;data:string}>()
    if(!row||kind==='pull'&&(row.meta!==access.meta||row.head!==head||row.base!==base))throw new PreparationPending()
    return JSON.parse(row.data) as Change
  }
  async ownerRepoCards(p:Principal,input:string,page=1,perPage=30){
    await this.active(p)
    if(!hasScope(p,'repo:read'))throw new ApiError(403,'Requires repo:read scope')
    const owner=await this.owner(input,p)
    if(owner.moving){if(this.structural(owner,p))throw new PreparationPending();throw new ApiError(404,'Not Found')}
    const catalogue=await this.db.prepare('SELECT checked_at FROM prepared_catalogues WHERE owner=? COLLATE NOCASE').bind(owner.name).first()
    if(!catalogue)throw new PreparationPending()
    const rows=await this.rows(owner,p,page,perPage)
    return {owner:owner.name,items:rows.slice(0,perPage).map(row=>this.card(row)),nextPage:rows.length>perPage?page+1:null}
  }
  async publicProfile(p:Principal,input:string):Promise<PublicDisplayProfile>{
    await this.active(p)
    const owner=await this.owner(input,p)
    if(owner.moving)throw new ApiError(404,'Not Found')
    const profile=owner.profile?JSON.parse(owner.profile) as Profile:emptyProfile()
    return {name:owner.name,kind:owner.kind,profile:{displayName:profile.displayName,publicEmail:profile.publicEmail,
      description:profile.description,url:profile.url,socialLinks:profile.socialLinks,location:profile.location},
      picture:await resolvePicture(profile.picture,owner.kind==='org'?profile.publicEmail:owner.email)}
  }
  async viewerContext(p:Principal,inputOwner?:string,inputRepo?:string):Promise<ViewerContext>{
    await this.active(p)
    if(!p.name)throw new ApiError(401,'Requires authentication')
    const profileRow=await this.db.prepare('SELECT p.data,c.email FROM (SELECT ? AS name) n LEFT JOIN profiles p ON p.name=n.name LEFT JOIN claims c ON c.name=n.name').bind(p.name).first<{data:string|null;email:string|null}>()
    const profile=profileRow?.data?JSON.parse(profileRow.data) as Profile:emptyProfile()
    let repository:ViewerContext['repository']=null
    if(inputRepo){
      if(!inputOwner||!repoPattern.test(inputRepo))throw new ApiError(404,'Not Found')
      if(!hasScope(p,'repo:read')||!permitsRepo(p,inputOwner,inputRepo))throw new ApiError(404,'Not Found')
      const owner=await this.owner(inputOwner,p)
      if(owner.moving)throw new ApiError(404,'Not Found')
      const row=(await this.rows(owner,p,1,1,inputRepo))[0]
      if(!row)throw new ApiError(404,'Not Found')
      this.card(row)
      const role=row.role,acl=JSON.parse(row.access_acl!) as ListingSnapshot['acl']
      const human=!p.name.includes('/'),admin=human&&(p.name.toLowerCase()===owner.name.toLowerCase()||role==='owner'||role==='admin')
      const writer=admin||human&&(acl.write??[]).some(name=>name.toLowerCase()==='@'+p.name.toLowerCase())
      const mutable=!row.archived&&!row.owner_archived
      const grants=acl.agents?.['@'+p.name]
      const branchWriter=writer||!human&&Array.isArray(grants)&&grants.includes('pr')
      const canPush=mutable&&branchWriter&&hasScope(p,'repo:write')
      // These are bounded operation capabilities, not a generic admin grant.
      // Mutations still reauthorize quota/ref/import/CAS and current policy.
      repository={owner:row.owner,name:row.name,read:true,
        editPackageManifest:mutable&&human&&writer&&hasScope(p,'repo:write'),
        pushNonDefaultBranch:canPush,pushDefaultBranch:canPush&&human&&writer,
        updateSettings:mutable&&admin&&hasScope(p,'admin')}

    }
    return {viewer:{name:p.name,kind:p.name.includes('/')?'agent':'human',displayName:profile.displayName,
      picture:await resolvePicture(profile.picture,profileRow?.email)},
      canCreateRepository:!p.name.includes('/')&&p.repos===null&&hasScope(p,'repo:write'),repository}
  }
}
