import { requestViewer, type ReadEnv } from './fragments/production.js'
import { d1Store } from './drivers/d1.js'
import { profileView } from './profile-view.js'
import { hasScope,permitsRepo } from '../engine/api/scopes.js'
import { mayRead } from './repo-read.js'
import type { ListingSnapshot } from './repo-list-snapshot.js'
/** Small private islands use explicit bindings and live authorization. They
 * never render a page or enter public HTML/data caches. */
export async function publicViewerHTTP(request:Request,env:ReadEnv) {
 const url=new URL(request.url)
 if(url.pathname!=='/api/viewer'||request.method!=='GET')return null
 const viewer=await requestViewer(request,env),st=d1Store(env.DB)
 const owner=url.searchParams.get('owner')
 const role=viewer&&owner?await st.orgRole(owner,viewer.name):null
 const repositories:{name:string;href:string}[]=[]
 if(viewer&&owner&&/^[a-z0-9][a-z0-9-]{0,38}$/.test(owner)&&hasScope(viewer,'repo:read')) {
  const rows=(await env.DB.prepare(`SELECT coalesce(e.key,l.id) AS address,l.data FROM repo_listing l
    LEFT JOIN settings_entities e ON e.id=l.id WHERE coalesce(e.key,l.id) LIKE ?`).bind(owner+'/%').all<{address:string;data:string}>()).results
  for(const row of rows) {
   const snapshot=JSON.parse(row.data) as ListingSnapshot,name=row.address.slice(owner.length+1)
   if(!(snapshot.acl.private||snapshot.acl.visibility==='private')||!permitsRepo(viewer,owner,name))continue
   if(await mayRead({store:st,index:async()=>null},owner,name,viewer.name))repositories.push({name,href:'/'+row.address})
  }
 }
 return Response.json({name:viewer?.name??null,picture:viewer?(await profileView(st,viewer.name)).picture:null,role,repositories},{headers:{'cache-control':'private, no-store'}})
}
