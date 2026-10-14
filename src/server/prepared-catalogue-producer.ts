import type {D1Database} from '@cloudflare/workers-types'

export interface CatalogueRepository {
  name:string;id:string;description:string|null;defaultBranch:string;
  createdAt:string|null;updatedAt:string|null
}
/** Producer-only publication. A receipt is committed with the complete
 * inventory, including a real empty inventory. Failed source reads cannot
 * publish an empty success. No destructive cleanup or schema mutation. */
export async function publishPreparedCatalogue(db:D1Database,owner:string,rows:CatalogueRepository[],checkedAt:number){
  if(!/^[a-z0-9][a-z0-9-]{0,38}$/.test(owner)||!Number.isSafeInteger(checkedAt))throw new Error('Invalid catalogue owner/observation')
  const names=new Set<string>()
  for(const row of rows){
    if(!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(row.name)||names.has(row.name.toLowerCase())||!row.id)throw new Error('Invalid catalogue repository')
    names.add(row.name.toLowerCase())
  }
  await db.batch([
    db.prepare('UPDATE prepared_repositories SET active=0,checked_at=? WHERE owner=? AND checked_at<?').bind(checkedAt,owner,checkedAt),
    ...rows.map(row=>db.prepare(`INSERT INTO prepared_repositories VALUES (?,?,?,1,?,?,?,?,?)
      ON CONFLICT(owner,name) DO UPDATE SET id=excluded.id,active=1,
      description=excluded.description,default_branch=excluded.default_branch,
      created_at=excluded.created_at,updated_at=excluded.updated_at,checked_at=excluded.checked_at
      WHERE prepared_repositories.checked_at<=excluded.checked_at`)
      .bind(owner,row.name,row.id,row.description,row.defaultBranch,row.createdAt,row.updatedAt,checkedAt)),
    db.prepare(`INSERT INTO prepared_catalogues VALUES (?,?) ON CONFLICT(owner)
      DO UPDATE SET checked_at=excluded.checked_at WHERE prepared_catalogues.checked_at<=excluded.checked_at`).bind(owner,checkedAt),
  ])
}

/** One current owner per existing cron, oldest observation first. External
 * Artifacts writes are reconciled here, never by an ordinary GET fallback. */
export async function reconcilePreparedCatalogue(db:D1Database,
  source:(owner:string,kind:'user'|'org')=>Promise<CatalogueRepository[]>,
  schedule:(owner:string,repo:CatalogueRepository)=>Promise<void>,now=Date.now()){
  const owner=await db.prepare(`SELECT n.name,n.kind FROM owner_names n
    LEFT JOIN settings_entities e ON e.key=n.name COLLATE NOCASE
    LEFT JOIN prepared_catalogues c ON c.owner=n.name COLLATE NOCASE
    WHERE n.kind IN ('user','org') AND e.deleted_at IS NULL AND coalesce(e.moving,0)=0
      AND coalesce(e.id,'') NOT LIKE 'reserve:%'
    ORDER BY coalesce(c.checked_at,0),n.name LIMIT 1`).first<{name:string;kind:'user'|'org'}>()
  if(!owner)return
  const rows=await source(owner.name,owner.kind)
  // This bounds producer-side fan-out. Larger catalogues retain honest Pending
  // until paginated reconciliation is provided; never certify a partial list.
  if(rows.length>1000)throw new Error('Catalogue needs paginated preparation')
  // Re-index only what changed outside gild since the last observation: an
  // unchanged repository's refresh re-ran its whole projection, every minute
  // per owner (13 Oct: most of the D1, Durable Object and Artifacts usage).
  const seen=new Map(((await db.prepare('SELECT name,id,updated_at FROM prepared_repositories WHERE owner=? COLLATE NOCASE AND active=1').bind(owner.name)
    .all<{name:string;id:string;updated_at:string|null}>()).results).map(r=>[r.name.toLowerCase(),r]))
  await publishPreparedCatalogue(db,owner.name,rows,now)
  for(const row of rows){
    const before=seen.get(row.name.toLowerCase())
    if(before&&before.id===row.id&&before.updated_at===row.updatedAt&&row.updatedAt!==null)continue
    await schedule(owner.name,row)
  }
}

/** One owner's repository list, observed now (an Artifacts create, delete,
 *  fork or import event). Indexing is triggered by the events themselves. */
export async function reconcileOwnerCatalogue(db:D1Database,owner:string,
  source:(owner:string,kind:'user'|'org')=>Promise<CatalogueRepository[]>,now=Date.now()){
  const named=await db.prepare('SELECT name,kind FROM owner_names WHERE name=? COLLATE NOCASE').bind(owner).first<{name:string;kind:'user'|'org'}>()
  if(!named)return
  const rows=await source(named.name,named.kind)
  if(rows.length>1000)throw new Error('Catalogue needs paginated preparation')
  await publishPreparedCatalogue(db,named.name,rows,now)
}
