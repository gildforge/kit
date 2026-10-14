import type {D1Database} from '@cloudflare/workers-types'

import {searchSnapshotKey,type SearchSnapshot,type SearchDocument} from '../engine/prepared-search-key.js'
export {searchSnapshotKey,type SearchSnapshot,type SearchDocument} from '../engine/prepared-search-key.js'
const SHA=/^[a-f0-9]{40}$/
export const SEARCH_STAGE_LIMIT=64
export const SEARCH_CONTENT_LIMIT=512*1024
function validateDocuments(documents:SearchDocument[]){
  const paths=new Set<string>()
  for(const d of documents){
    if(!d||typeof d.path!=='string'||!d.path||d.path.length>4096||paths.has(d.path)||!SHA.test(d.blob)
      ||typeof d.language!=='string'||d.language.length>100||typeof d.content!=='string'||new TextEncoder().encode(d.content).length>SEARCH_CONTENT_LIMIT
      ||!Array.isArray(d.symbols)||d.symbols.length>10000||d.symbols.some(s=>!s||typeof s.name!=='string'||s.name.length>512||typeof s.kind!=='string'||s.kind.length>100||!Number.isSafeInteger(s.line)||s.line<1))
      throw new Error('Invalid prepared search document')
    if(new TextEncoder().encode(JSON.stringify(d.symbols)).length>256*1024)throw new Error('Search symbols exceed document budget')
    paths.add(d.path)
  }
}
/** Producer-only paginated immutable document staging. No receipt is created
 * by staging, so a failed or truncated file walk cannot produce an empty hit. */
export async function stagePreparedSearchDocuments(db:D1Database,snapshot:SearchSnapshot,documents:SearchDocument[]){
  const key=searchSnapshotKey(snapshot)
  if(documents.length>SEARCH_STAGE_LIMIT)throw new Error('Search document page exceeds stage limit')
  validateDocuments(documents)
  if(!documents.length)return
  await db.batch(documents.map(d=>db.prepare(`INSERT INTO prepared_search_documents SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM prepared_search_receipts WHERE snapshot=?)
    ON CONFLICT(snapshot,path) DO UPDATE SET blob=excluded.blob,language=excluded.language,content=excluded.content,symbols=excluded.symbols,search_path=excluded.search_path,search_content=excluded.search_content WHERE NOT EXISTS (SELECT 1 FROM prepared_search_receipts WHERE snapshot=?)`)
    .bind(key,d.path,d.blob,d.language,d.content,JSON.stringify(d.symbols),d.path.toLowerCase(),d.content.toLowerCase(),key,key)))
}
/** Certify only a complete source inventory whose count matches staged rows,
 * and only while its captured ref epoch/meta/tip is still advertised. */
export async function publishPreparedSearchReceipt(db:D1Database,snapshot:SearchSnapshot,total:number){
  const key=searchSnapshotKey(snapshot)
  if(!Number.isSafeInteger(total)||total<0)throw new Error('Invalid complete search inventory count')
  const result=await db.prepare(`INSERT INTO prepared_search_receipts
    SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM prepared_search_documents WHERE snapshot=?)=?
    AND EXISTS (SELECT 1 FROM prepared_repository_refs r,json_each(r.data,'$.refs') advertised
      WHERE r.id=? AND r.epoch=? AND r.pending=0 AND r.meta IS ?
        AND json_extract(advertised.value,'$.name')=? AND json_extract(advertised.value,'$.hash')=?)
    ON CONFLICT(snapshot) DO UPDATE SET document_count=excluded.document_count`)
    .bind(key,snapshot.id,snapshot.epoch,snapshot.ref,snapshot.tip,snapshot.meta,total,key,total,
      snapshot.id,snapshot.epoch,snapshot.meta,snapshot.ref,snapshot.tip).run()
  return Number(result.meta.changes??0)>0
}
/** Convenience for small/complete indexed inventories. Larger inventories can
 * stream fixed pages with stagePreparedSearchDocuments then certify once. */
export async function publishPreparedSearch(db:D1Database,snapshot:SearchSnapshot,documents:SearchDocument[],complete:boolean){
  searchSnapshotKey(snapshot);validateDocuments(documents)
  if(!complete)throw new Error('Search source inventory is not complete')
  for(let i=0;i<documents.length;i+=SEARCH_STAGE_LIMIT)await stagePreparedSearchDocuments(db,snapshot,documents.slice(i,i+SEARCH_STAGE_LIMIT))
  return publishPreparedSearchReceipt(db,snapshot,documents.length)
}
