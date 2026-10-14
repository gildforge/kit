import type {D1Database} from '@cloudflare/workers-types'
import {d1Store} from './drivers/d1.js'
import {publishPreparedCatalogue,type CatalogueRepository} from './prepared-catalogue-producer.js'

/** Background/write producer source, shared with cron. Never a GET fallback. */
export async function observedOwnerCatalogue(db:D1Database,owner:string,kind:'user'|'org',credential?:string):Promise<CatalogueRepository[]>{
  const {rawListRepos,nsFor}=await import('./artifacts.js')
  const store=d1Store(db),rows=await rawListRepos(nsFor(owner,kind),credential),result=[]
  // The current source caps at 200. A full page cannot prove that the
  // inventory is complete; keep Pending until paginated observation exists.
  if(rows.length>=200)throw new Error('Catalogue needs paginated preparation')
  for(const row of rows){
    const key=await store.settings.canonical(owner+'/'+row.name),state=await store.settings.state(key)
    if(state.deletedAt!==null||state.moving||key.split('/')[0]!==owner)continue
    result.push({name:key.slice(owner.length+1),id:state.id,description:state.description??row.description??null,
      defaultBranch:state.defaultBranch??row.default_branch,createdAt:row.created_at??null,updatedAt:row.updated_at??null})
  }
  return result
}

/** A background page producer can bootstrap the complete owner's inventory
 * before its SSR read; preparation never runs in the user's document GET. */
export async function ensurePreparedOwnerCatalogue(db:D1Database,input:string,now=Date.now(),credential?:string,repository?:string){
  const receipt=await db.prepare('SELECT checked_at FROM prepared_catalogues WHERE owner=? COLLATE NOCASE').bind(input).first<{checked_at:number}>()
  if(receipt&&(!repository||await db.prepare('SELECT id FROM prepared_repositories WHERE owner=? COLLATE NOCASE AND name=? COLLATE NOCASE AND active=1 AND checked_at=?').bind(input,repository,receipt.checked_at).first()))return
  const owner=await db.prepare(`SELECT n.name,n.kind FROM owner_names n LEFT JOIN settings_entities e ON e.key=n.name
    WHERE n.name=? COLLATE NOCASE AND n.kind IN ('user','org') AND e.deleted_at IS NULL
    AND coalesce(e.moving,0)=0 AND coalesce(e.id,'') NOT LIKE 'reserve:%'`).bind(input).first<{name:string;kind:'user'|'org'}>()
  if(!owner)return
  const rows=await observedOwnerCatalogue(db,owner.name,owner.kind,credential)
  if(rows.length>1000)throw new Error('Catalogue needs paginated preparation')
  await publishPreparedCatalogue(db,owner.name,rows,now)
}
