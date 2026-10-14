import type {D1Database} from '@cloudflare/workers-types'
import type {CatalogueRepository} from './prepared-catalogue-producer.js'

export interface CatalogueObservation {owner:string;kind:'user'|'org';generation:string;startedAt:number}
export interface CataloguePageFacts {cursor:string|null;nextCursor:string|null;terminal:boolean;rowCount:number;digest:string}
export interface CatalogueSourcePage {generation:string;cursor:string|null;nextCursor:string|null;terminal:boolean;rows:CatalogueRepository[]}
export type CataloguePageSource=(owner:string,kind:'user'|'org',cursor:string|null,generation:string)=>Promise<CatalogueSourcePage>
export interface CatalogueProgress {cursor:string|null;page:number;terminal:number;published:number}
const key=(cursor:string|null)=>JSON.stringify(cursor)
function validateTicket(t:CatalogueObservation){
  if(!/^[a-z0-9][a-z0-9-]{0,38}$/.test(t.owner)||!['user','org'].includes(t.kind)||!t.generation
    ||!Number.isSafeInteger(t.startedAt)||t.startedAt<0)throw new Error('Invalid catalogue observation')
}
function cursor(value:unknown){if(value!==null&&(typeof value!=='string'||!value||value.length>4096))throw new Error('Invalid catalogue cursor')}
function validateRows(rows:CatalogueRepository[]){
  const names=new Set<string>()
  for(const r of rows){
    if(!r||!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(r.name)||names.has(r.name.toLowerCase())
      ||typeof r.id!=='string'||!r.id||typeof r.defaultBranch!=='string'||!r.defaultBranch
      ||r.description!==null&&typeof r.description!=='string'||r.createdAt!==null&&typeof r.createdAt!=='string'
      ||r.updatedAt!==null&&typeof r.updatedAt!=='string')throw new Error('Invalid or duplicate catalogue repository')
    names.add(r.name.toLowerCase())
  }
}
function validatePage(p:CataloguePageFacts){
  cursor(p.cursor);cursor(p.nextCursor)
  if(typeof p.terminal!=='boolean'||!Number.isSafeInteger(p.rowCount)||p.rowCount<0||p.rowCount>200||!/^[a-f0-9]{64}$/.test(p.digest))
    throw new Error('Catalogue page requires explicit bounded completeness facts')
  if(p.terminal?p.nextCursor!==null:p.nextCursor===null||p.nextCursor===p.cursor)throw new Error('Invalid terminal or cyclic catalogue cursor')
}
// Current kind/lifecycle is checked in every mutation, including final publish.
const current=`EXISTS (SELECT 1 FROM owner_names n LEFT JOIN settings_entities e ON e.key=n.name COLLATE NOCASE
  WHERE n.name=o.owner COLLATE NOCASE AND n.kind=o.kind AND e.deleted_at IS NULL AND coalesce(e.moving,0)=0
  AND coalesce(e.id,'') NOT LIKE 'reserve:%')`
const captured=`o.owner=? COLLATE NOCASE AND o.generation=? AND o.kind=? AND o.started_at=? AND ${current}`
const args=(t:CatalogueObservation)=>[t.owner,t.generation,t.kind,t.startedAt]
const changed=(result:any)=>Number(result.meta?.changes??0)>0

/** Write/background only. A newer observation replaces only the producer
 * cursor; the last complete reader generation remains intact. */
export async function beginCatalogueObservation(db:D1Database,t:CatalogueObservation){
  validateTicket(t)
  await db.prepare(`INSERT INTO prepared_catalogue_observations(owner,kind,generation,started_at)
    SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM owner_names n LEFT JOIN settings_entities e ON e.key=n.name COLLATE NOCASE
      WHERE n.name=? COLLATE NOCASE AND n.kind=? AND e.deleted_at IS NULL AND coalesce(e.moving,0)=0 AND coalesce(e.id,'') NOT LIKE 'reserve:%')
    AND NOT EXISTS (SELECT 1 FROM prepared_catalogues WHERE owner=? COLLATE NOCASE AND checked_at>=?)
    ON CONFLICT(owner) DO UPDATE SET kind=excluded.kind,generation=excluded.generation,started_at=excluded.started_at,
      cursor=NULL,page=0,terminal=0,published=0 WHERE prepared_catalogue_observations.started_at<excluded.started_at
      AND prepared_catalogue_observations.generation!=excluded.generation`)
    .bind(t.owner,t.kind,t.generation,t.startedAt,t.owner,t.kind,t.owner,t.startedAt).run()
  return await catalogueObservationProgress(db,t)
}
export async function catalogueObservationProgress(db:D1Database,t:CatalogueObservation):Promise<CatalogueProgress|null>{
  validateTicket(t)
  return await db.prepare(`SELECT o.cursor,o.page,o.terminal,o.published FROM prepared_catalogue_observations o WHERE ${captured}`)
    .bind(...args(t)).first<CatalogueProgress>()
}
/** Restore the durable producer ticket after an alarm/process interruption.
 * This is a producer control read, never an ordinary catalogue GET adapter. */
export async function resumableCatalogueObservation(db:D1Database,owner:string){
  if(!/^[a-z0-9][a-z0-9-]{0,38}$/.test(owner))throw new Error('Invalid catalogue owner')
  return await db.prepare(`SELECT o.owner,o.kind,o.generation,o.started_at AS startedAt,o.cursor,o.page,o.terminal,o.published
    FROM prepared_catalogue_observations o WHERE o.owner=? COLLATE NOCASE AND ${current}`)
    .bind(owner).first<CatalogueObservation&CatalogueProgress>()
}
/** Capture a complete source page descriptor before any row chunk. Reopening
 * the exact unfinished descriptor resumes; committed cursor replay rejects. */
export async function beginCataloguePage(db:D1Database,t:CatalogueObservation,p:CataloguePageFacts){
  validateTicket(t);validatePage(p)
  const progress=await catalogueObservationProgress(db,t)
  if(!progress||progress.terminal||progress.published||progress.cursor!==p.cursor)throw new Error('Stale or replayed catalogue page')
  if(p.nextCursor!==null&&await db.prepare('SELECT 1 FROM prepared_catalogue_pages WHERE owner=? AND generation=? AND cursor_key=?')
    .bind(t.owner,t.generation,key(p.nextCursor)).first())throw new Error('Catalogue cursor cycle')
  await db.prepare(`INSERT INTO prepared_catalogue_pages(owner,generation,cursor_key,page,next_cursor,terminal,row_count,digest)
    SELECT o.owner,o.generation,?,o.page,?,?,?,? FROM prepared_catalogue_observations o
    WHERE ${captured} AND o.cursor IS ? AND o.terminal=0 AND o.published=0
    ON CONFLICT(owner,generation,cursor_key) DO NOTHING`)
    .bind(key(p.cursor),p.nextCursor,p.terminal?1:0,p.rowCount,p.digest,...args(t),p.cursor).run()
  const stored=await db.prepare(`SELECT next_cursor,terminal,row_count,digest,next_offset,committed FROM prepared_catalogue_pages
    WHERE owner=? AND generation=? AND cursor_key=?`).bind(t.owner,t.generation,key(p.cursor))
    .first<{next_cursor:string|null;terminal:number;row_count:number;digest:string;next_offset:number;committed:number}>()
  if(!stored||stored.committed||stored.next_cursor!==p.nextCursor||stored.terminal!==(p.terminal?1:0)||stored.row_count!==p.rowCount||stored.digest!==p.digest)
    throw new Error('Catalogue page observation changed or replayed')
  return stored.next_offset
}
/** At most 100 rows per D1 batch. Durable exact offset rejects replay; a failed
 * batch cannot advance the page cursor or certify a partial inventory. */
export async function stageCataloguePageRows(db:D1Database,t:CatalogueObservation,inputCursor:string|null,offset:number,rows:CatalogueRepository[]){
  validateTicket(t);cursor(inputCursor);validateRows(rows)
  if(!Number.isSafeInteger(offset)||offset<0||!rows.length||rows.length>100)throw new Error('Invalid catalogue staging batch')
  const stageGate=`EXISTS (SELECT 1 FROM prepared_catalogue_observations o JOIN prepared_catalogue_pages p
    ON p.owner=o.owner AND p.generation=o.generation AND p.page=o.page WHERE ${captured}
    AND o.cursor IS ? AND o.terminal=0 AND o.published=0 AND p.committed=0 AND p.next_offset=? AND p.row_count>=?)`
  const gateArgs=[...args(t),inputCursor,offset,offset+rows.length]
  const result=await db.batch([
    db.prepare(`INSERT INTO prepared_catalogue_page_rows SELECT ?,?,json_extract(j.value,'$[0]'),json_extract(j.value,'$[1]'),
      json_extract(j.value,'$[2]'),json_extract(j.value,'$[3]'),json_extract(j.value,'$[4]'),json_extract(j.value,'$[5]'),o.page,?+cast(j.key AS INTEGER)
      FROM json_each(?) j JOIN prepared_catalogue_observations o ON o.owner=? WHERE ${stageGate}`)
      .bind(t.owner,t.generation,offset,JSON.stringify(rows.map(r=>[r.name,r.id,r.description,r.defaultBranch,r.createdAt,r.updatedAt])),t.owner,...gateArgs),
    db.prepare(`UPDATE prepared_catalogue_pages SET next_offset=? WHERE owner=? AND generation=? AND cursor_key=? AND ${stageGate}`)
      .bind(offset+rows.length,t.owner,t.generation,key(inputCursor),...gateArgs),
  ])
  if(!changed(result.at(-1)))throw new Error('Stale, replayed or oversized catalogue staging batch')
  return offset+rows.length
}
export async function commitCataloguePage(db:D1Database,t:CatalogueObservation,inputCursor:string|null){
  validateTicket(t);cursor(inputCursor)
  const progress=await catalogueObservationProgress(db,t)
  if(!progress||progress.cursor!==inputCursor||progress.terminal||progress.published)return false
  const stored=await db.prepare('SELECT row_count,next_offset,digest,committed FROM prepared_catalogue_pages WHERE owner=? AND generation=? AND cursor_key=?')
    .bind(t.owner,t.generation,key(inputCursor)).first<{row_count:number;next_offset:number;digest:string;committed:number}>()
  if(!stored||stored.committed||stored.next_offset!==stored.row_count)return false
  const rows=(await db.prepare(`SELECT name,id,description,default_branch AS defaultBranch,created_at AS createdAt,updated_at AS updatedAt
    FROM prepared_catalogue_page_rows WHERE owner=? AND generation=? AND page=? ORDER BY ordinal LIMIT 201`)
    .bind(t.owner,t.generation,progress.page).all<CatalogueRepository>()).results
  if(rows.length!==stored.row_count)return false
  if(await cataloguePageDigest(rows)!==stored.digest)throw new Error('Catalogue staged page differs from observed source')
  const ready=`EXISTS (SELECT 1 FROM prepared_catalogue_observations o WHERE ${captured} AND o.cursor IS ?
    AND o.terminal=0 AND o.published=0 AND o.page=prepared_catalogue_pages.page)`
  const result=await db.batch([
    db.prepare(`UPDATE prepared_catalogue_pages SET committed=1 WHERE owner=? AND generation=? AND cursor_key=? AND committed=0
      AND next_offset=row_count AND row_count=(SELECT count(*) FROM prepared_catalogue_page_rows r WHERE r.owner=prepared_catalogue_pages.owner
        AND r.generation=prepared_catalogue_pages.generation AND r.page=prepared_catalogue_pages.page) AND ${ready}`)
      .bind(t.owner,t.generation,key(inputCursor),...args(t),inputCursor),
    db.prepare(`UPDATE prepared_catalogue_observations AS o SET cursor=(SELECT p.next_cursor FROM prepared_catalogue_pages p WHERE p.owner=o.owner AND p.generation=o.generation AND p.page=o.page),
      terminal=(SELECT p.terminal FROM prepared_catalogue_pages p WHERE p.owner=o.owner AND p.generation=o.generation AND p.page=o.page),page=page+1
      WHERE ${captured} AND o.cursor IS ? AND o.terminal=0 AND o.published=0 AND EXISTS
        (SELECT 1 FROM prepared_catalogue_pages p WHERE p.owner=o.owner AND p.generation=o.generation AND p.page=o.page AND p.committed=1)`)
      .bind(...args(t),inputCursor),
  ])
  return changed(result.at(-1))
}
/** One atomic INSERT...SELECT publishes all staged rows without catalogue-sized
 * bind lists or per-repository fan-out. Partial scans never alter reader tables. */
export async function publishCatalogueObservation(db:D1Database,t:CatalogueObservation){
  validateTicket(t)
  const complete=`EXISTS (SELECT 1 FROM prepared_catalogue_observations o WHERE ${captured} AND o.terminal=1 AND o.published=0
    AND o.page=(SELECT count(*) FROM prepared_catalogue_pages p WHERE p.owner=o.owner AND p.generation=o.generation AND p.committed=1)
    AND NOT EXISTS (SELECT 1 FROM prepared_catalogues c WHERE c.owner=o.owner AND c.checked_at>=o.started_at))`
  const result=await db.batch([
    db.prepare(`UPDATE prepared_repositories SET active=0,checked_at=? WHERE owner=? AND checked_at<? AND ${complete}`)
      .bind(t.startedAt,t.owner,t.startedAt,...args(t)),
    db.prepare(`INSERT INTO prepared_repositories SELECT r.owner,r.name,r.id,1,r.description,r.default_branch,r.created_at,r.updated_at,?
      FROM prepared_catalogue_page_rows r WHERE r.owner=? AND r.generation=? AND ${complete}
      ON CONFLICT(owner,name) DO UPDATE SET id=excluded.id,active=1,description=excluded.description,default_branch=excluded.default_branch,
        created_at=excluded.created_at,updated_at=excluded.updated_at,checked_at=excluded.checked_at WHERE prepared_repositories.checked_at<=excluded.checked_at`)
      .bind(t.startedAt,t.owner,t.generation,...args(t)),
    db.prepare(`INSERT INTO prepared_catalogues SELECT ?,? WHERE ${complete} ON CONFLICT(owner) DO UPDATE SET checked_at=excluded.checked_at
      WHERE prepared_catalogues.checked_at<excluded.checked_at`).bind(t.owner,t.startedAt,...args(t)),
    db.prepare(`UPDATE prepared_catalogue_observations AS o SET published=1 WHERE ${captured} AND o.terminal=1
      AND EXISTS (SELECT 1 FROM prepared_catalogues c WHERE c.owner=o.owner AND c.checked_at=o.started_at)`)
      .bind(...args(t)),
  ])
  return changed(result.at(-1))
}

export async function cataloguePageDigest(rows:CatalogueRepository[]){
  validateRows(rows)
  const serialized=JSON.stringify(rows.map(r=>[r.name,r.id,r.description,r.defaultBranch,r.createdAt,r.updatedAt]))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serialized))),b=>b.toString(16).padStart(2,'0')).join('')
}
/** One source page per invocation, never an unbounded owner scan. Parent's
 * source adapter supplies explicit cursor/terminal metadata and current row
 * canonicalization; this port performs no network or observes a source on GET. */
export async function advanceCatalogueObservation(db:D1Database,t:CatalogueObservation,source:CataloguePageSource){
  const progress=await catalogueObservationProgress(db,t)
  if(!progress)return {ready:false,progress:null}
  if(progress.terminal)return {ready:await publishCatalogueObservation(db,t),progress:await catalogueObservationProgress(db,t)}
  const p=await source(t.owner,t.kind,progress.cursor,t.generation)
  if(p.generation!==t.generation||p.cursor!==progress.cursor||!Array.isArray(p.rows)||p.rows.length>200)throw new Error('Mismatched catalogue source page')
  const facts={cursor:p.cursor,nextCursor:p.nextCursor,terminal:p.terminal,rowCount:p.rows.length,digest:await cataloguePageDigest(p.rows)}
  let offset=await beginCataloguePage(db,t,facts)
  while(offset<p.rows.length)offset=await stageCataloguePageRows(db,t,p.cursor,offset,p.rows.slice(offset,offset+100))
  if(!await commitCataloguePage(db,t,p.cursor))throw new Error('Catalogue page remains Pending')
  const current=await catalogueObservationProgress(db,t)
  return {ready:!!current?.terminal&&await publishCatalogueObservation(db,t),progress:await catalogueObservationProgress(db,t)}
}
